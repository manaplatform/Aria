import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { resolvePublicAddress } from '@aria/shared';
import { RuntimeError, digest } from './store';

const maximum = 10_000_000;

export async function downloadVerified(value: string, expected: string, signal: AbortSignal) {
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
  if (!data.length || digest(data) !== expected)
    throw new RuntimeError(
      'EXECUTION_FAILED',
      'The downloaded file did not match the approved checksum.',
    );
  return data;
}
