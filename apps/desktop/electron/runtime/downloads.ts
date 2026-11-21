import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { resolvePublicAddress } from '@aria/shared';
import { RuntimeError, digest } from './store';

const maximum = 10_000_000;

export async function downloadVerified(value: string, expected: string, signal: AbortSignal) {
  const data = await downloadPublicFile(value, signal);
  if (digest(data) !== expected)
    throw new RuntimeError(
      'EXECUTION_FAILED',
      'The downloaded file did not match the approved checksum.',
    );
  return data;
}

function publicDestination(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port
  )
    throw new RuntimeError(
      'INVALID_ARGUMENT',
      'Use a public HTTPS URL without credentials, a query string, a fragment, or a custom port.',
    );
  return url;
}

export async function downloadPublicFile(value: string, signal: AbortSignal) {
  const url = publicDestination(value);
  const address = await resolvePublicAddress(url.hostname, (host) => lookup(host, { all: true }));
  signal.throwIfAborted();
  const data = await new Promise<Buffer>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        signal,
        agent: false,
        headers: { 'Accept-Encoding': 'identity' },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      },
      (response) => {
        const parts: Buffer[] = [];
        let received = 0;
        if (response.statusCode !== 200 || Number(response.headers['content-length']) > maximum) {
          response.destroy();
          reject(
            new RuntimeError(
              'EXECUTION_FAILED',
              'The approved URL returned a redirect, an error, or an oversized file.',
            ),
          );
          return;
        }
        response.on('data', (part: Buffer) => {
          received += part.length;
          if (received > maximum) {
            response.destroy(new Error('The download exceeded its byte limit.'));
            return;
          }
          parts.push(part);
        });
        response.on('error', reject);
        response.on('end', () => resolve(Buffer.concat(parts, received)));
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error('The download timed out.')));
    req.on('error', reject);
    req.end();
  });
  if (!data.length) throw new RuntimeError('EXECUTION_FAILED', 'The downloaded file was empty.');
  return data;
}

export async function uploadPublicFile(
  value: string,
  field: string,
  filename: string,
  mimeType: string,
  bytes: Buffer,
  signal: AbortSignal,
) {
  const url = publicDestination(value);
  if (
    !/^[A-Za-z0-9_.-]{1,80}$/.test(field) ||
    !/^[a-z\d+.-]+\/[a-z\d+.-]+$/i.test(mimeType) ||
    !bytes.length ||
    bytes.length > maximum
  )
    throw new RuntimeError('INVALID_ARGUMENT', 'Select a supported attachment of at most 10 MB.');
  const name = filename.replace(/[^\p{L}\p{N}_. -]/gu, '_').slice(0, 140) || 'attachment';
  const boundary = `aria-${randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const address = await resolvePublicAddress(url.hostname, (host) => lookup(host, { all: true }));
  signal.throwIfAborted();
  return new Promise<number>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        signal,
        agent: false,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          Origin: url.origin,
        },
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.destroy();
        if (status >= 200 && status < 300) resolve(status);
        else
          reject(
            new RuntimeError(
              'OUTCOME_UNCERTAIN',
              'The site did not return a direct success response. Verify the upload before sending it again.',
            ),
          );
      },
    );
    req.setTimeout(15_000, () => req.destroy());
    req.on('error', () =>
      reject(
        new RuntimeError(
          'OUTCOME_UNCERTAIN',
          'The upload connection ended. Check the site before trying again.',
        ),
      ),
    );
    req.end(body);
  });
}
