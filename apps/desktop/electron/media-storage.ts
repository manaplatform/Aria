import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LocalData, MediaAsset } from '@aria/shared';
export const assetSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(255),
    mimeType: z.enum([
      'text/plain',
      'image/png',
      'image/jpeg',
      'image/webp',
      'audio/flac',
      'audio/mpeg',
      'audio/mp4',
      'video/mp4',
      'audio/ogg',
      'audio/wav',
      'audio/webm',
      'video/webm',
    ]),
    size: z.number().int().positive().max(64_000_000),
  })
  .strict();
export function identifyMedia(bytes: Buffer): string {
  const hex = bytes.subarray(0, 12).toString('hex');
  const ascii = bytes.toString('ascii', 0, 12);
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (ascii.startsWith('RIFF') && ascii.endsWith('WEBP')) return 'image/webp';
  if (ascii.startsWith('RIFF') && ascii.endsWith('WAVE')) return 'audio/wav';
  if (ascii.startsWith('fLaC')) return 'audio/flac';
  if (ascii.startsWith('OggS')) return 'audio/ogg';
  if (ascii.slice(4, 8) === 'ftyp') return 'audio/mp4';
  if (hex.startsWith('1a45dfa3')) return 'audio/webm';
  if (
    ascii.startsWith('ID3') ||
    (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0) ||
    hex.startsWith('000001')
  )
    return 'audio/mpeg';
  throw new Error('This file is not a supported image or audio file.');
}
export class MediaStorage {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = path.join(directory, 'media');
  }
  private filename(id: string, suffix = '') {
    return path.join(this.directory, `${z.string().uuid().parse(id)}${suffix}`);
  }
  private textType(bytes: Buffer) {
    if (
      bytes.length > 1_000_000 ||
      new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0')
    )
      throw new Error('Choose a UTF-8 text file up to 1 MB.');
    return 'text/plain';
  }
  async put(bytes: Buffer, name: string, expected?: string): Promise<MediaAsset> {
    const mimeType = expected === 'text/plain' ? this.textType(bytes) : identifyMedia(bytes);
    if (expected && expected !== mimeType)
      throw new Error('The provider returned an unexpected media format.');
    const asset = assetSchema.parse({
      id: randomUUID(),
      name: path.basename(name).slice(0, 255),
      mimeType,
      size: bytes.length,
    });
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(this.filename(asset.id, '.tmp'), bytes, { mode: 0o600 });
    await fs.rename(this.filename(asset.id, '.tmp'), this.filename(asset.id));
    try {
      await fs.writeFile(this.filename(asset.id, '.json'), JSON.stringify(asset), { mode: 0o600 });
    } catch (error) {
      await fs.rm(this.filename(asset.id), { force: true });
      throw error;
    }
    return asset;
  }
  async get(id: string): Promise<{ asset: MediaAsset; bytes: Buffer }> {
    try {
      const asset = assetSchema.parse(
        JSON.parse(await fs.readFile(this.filename(id, '.json'), 'utf8')),
      );
      if (asset.id !== id) throw new Error('Mismatched asset.');
      const file = await fs.open(this.filename(id), 'r');
      let bytes: Buffer;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== asset.size) throw new Error('Invalid asset size.');
        bytes = Buffer.alloc(asset.size);
        if ((await file.read(bytes, 0, bytes.length, 0)).bytesRead !== asset.size)
          throw new Error('Incomplete asset.');
      } finally {
        await file.close();
      }
      if (
        bytes.length !== asset.size ||
        (asset.mimeType === 'text/plain' ? this.textType(bytes) : identifyMedia(bytes)) !==
          asset.mimeType
      )
        throw new Error('Invalid asset.');
      return { asset, bytes };
    } catch {
      throw new Error('This media file is missing or unreadable.');
    }
  }
  async import(filename: string, kind: 'image' | 'audio' | 'text' | 'any'): Promise<MediaAsset> {
    const stat = await fs.stat(filename);
    const isText =
      kind === 'text' ||
      (kind === 'any' &&
        /\.(txt|md|csv|tsv|json|[cm]?[jt]sx?|py|html|css|ya?ml|xml|toml|log|rs|go|java|sql)$/i.test(
          filename,
        ));
    const max = isText ? 1_000_000 : kind === 'image' ? 20_000_000 : 25_000_000;
    if (!stat.isFile() || stat.size > max)
      throw new Error(`Choose a supported file up to ${max / 1_000_000} MB.`);
    const bytes = await fs.readFile(filename);
    const mime = isText ? this.textType(bytes) : identifyMedia(bytes);
    if (mime.startsWith('image/') && bytes.length > 20_000_000)
      throw new Error('Choose an image up to 20 MB.');
    if (
      (kind === 'image' && !mime.startsWith('image/')) ||
      (kind === 'audio' && mime.startsWith('image/'))
    )
      throw new Error(`Choose a supported ${kind} file.`);
    return this.put(bytes, path.basename(filename), mime);
  }
  async remove(id: string) {
    await Promise.all([
      fs.rm(this.filename(id), { force: true }),
      fs.rm(this.filename(id, '.json'), { force: true }),
      fs.rm(this.filename(id, '.tmp'), { force: true }),
    ]);
  }
  async pruneUnreferenced(data: LocalData) {
    const retained = referencedAssets(data);
    const names = await fs.readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of names) {
      const id = name.replace(/\.(tmp|json)$/, '');
      if (z.string().uuid().safeParse(id).success && !retained.has(id)) await this.remove(id);
    }
  }

  async prune(previous: LocalData, next: LocalData) {
    const retained = referencedAssets(next);
    await Promise.all(
      [...referencedAssets(previous)]
        .filter((id) => !retained.has(id))
        .map(async (id) => {
          await fs.rm(this.filename(id), { force: true });
          await fs.rm(this.filename(id, '.json'), { force: true });
        }),
    );
  }
}
export function referencedAssets(data: LocalData): Set<string> {
  return new Set([
    ...data.chat.messages.flatMap((m) => [
      ...(m.assets?.map((a) => a.id) || []),
      ...(m.operation?.assetIds || []),
    ]),
    ...data.chat.conversations.flatMap((c) => c.attachments?.map((a) => a.id) || []),
    ...(data.chat.newAttachments?.map((a) => a.id) || []),
  ]);
}
export function pcmWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
