import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fetchUpdateResponse, type VerifiedUpdate } from './update-feed';

type Download = VerifiedUpdate['download'];
const run = promisify(execFile);

export async function verifyMacUpdate(file: string, expected: Download) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size !== expected.size)
    throw new Error('The disk image failed size validation. Download the update again.');
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk);
    sha512.update(chunk);
  }
  if (sha256.digest('hex') !== expected.sha256 || sha512.digest('base64') !== expected.sha512)
    throw new Error('The disk image failed checksum validation. Download the update again.');
}

export async function downloadMacUpdate(directory: string, download: Download, progress: (percent: number) => void) {
  const scratch = await mkdtemp(path.join(directory, '.aria-update-'));
  const temporary = path.join(scratch, 'download.dmg');
  const installer = path.join(directory, 'Aria-update.dmg');
  try {
    const signal = AbortSignal.timeout(10 * 60_000);
    const stream = await fetchUpdateResponse(download.url, signal);
    const reader = stream.getReader();
    const chunks = async function* () {
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          total += value.byteLength;
          if (total > download.size) throw new Error('The disk image exceeded its signed size.');
          progress(Math.min(99, Math.floor(100 * total / download.size)));
          yield value;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    };
    await pipeline(chunks(), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
    await verifyMacUpdate(temporary, download);
    // Main-process downloads need the internet-download quarantine marker so
    // macOS applies its normal first-launch policy to the new app.
    await run('/usr/bin/xattr', ['-w', 'com.apple.quarantine',
      `0081;${Math.floor(Date.now() / 1000).toString(16)};Aria;`, temporary], { timeout: 10_000 });
    await rename(temporary, installer);
    return installer;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
