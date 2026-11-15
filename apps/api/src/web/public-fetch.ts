import { lookup } from 'node:dns/promises';
import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Readable } from 'node:stream';
import { publicWebUrl, resolvePublicAddress } from '@aria/shared';

const maxBytes = 2 * 1024 * 1024;

async function* limited(input: AsyncIterable<Buffer>, signal: AbortSignal) {
  let received = 0;
  for await (const chunk of input) {
    signal.throwIfAborted();
    received += chunk.length;
    if (received > maxBytes) throw new Error('The page exceeded the download limit.');
    yield chunk;
  }
}

export async function publicFetch(input: string, parent: AbortSignal) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
  let url = publicWebUrl(input);
  for (let hop = 0; hop <= 5; hop++) {
    const address = await resolvePublicAddress(url.hostname, (host) => lookup(host, { all: true }));
    signal.throwIfAborted();
    const send = url.protocol === 'https:' ? https : http;
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = send(
        url,
        {
          signal,
          agent: false,
          family: address.family,
          lookup: (_host, _options, done) => done(null, address.address, address.family),
          headers: {
            Accept: 'text/html, text/plain;q=0.9',
            'Accept-Encoding': 'gzip, br, deflate',
          },
        },
        resolve,
      );
      request.on('error', reject);
      request.end();
    });
    try {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        url = publicWebUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (status !== 200) throw new Error(`The website returned HTTP ${status}.`);
      const header = response.headers['content-type'] || '';
      const mime = header.split(';')[0].trim().toLowerCase();
      if (!['text/html', 'text/plain', 'application/xhtml+xml'].includes(mime))
        throw new Error('The website did not return a supported HTML or text document.');
      const decoding = { gzip: createGunzip, br: createBrotliDecompress, deflate: createInflate };
      const encoding = response.headers['content-encoding']?.toLowerCase() || 'identity';
      const compressed = Readable.from(limited(response, signal));
      const decoder = decoding[encoding as keyof typeof decoding]?.();
      if (!decoder && encoding !== 'identity') throw new Error('Unsupported page encoding.');
      if (decoder) compressed.on('error', (error) => decoder.destroy(error));
      const stream = decoder ? compressed.pipe(decoder) : compressed;
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of limited(stream, signal)) chunks.push(chunk);
        const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(header)?.[1] || 'utf-8';
        url.hash = '';
        return {
          url: url.href,
          mime,
          body: new TextDecoder(charset).decode(Buffer.concat(chunks)),
        };
      } finally {
        compressed.destroy();
        decoder?.destroy();
      }
    } finally {
      response.destroy();
    }
  }
  throw new Error('The website redirected too many times.');
}
