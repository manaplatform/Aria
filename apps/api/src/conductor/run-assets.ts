import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { conductorLimits, type ArtifactReference } from '@aria/shared';

export interface RunFile {
  name: string;
  mimeType: string;
  bytes: Buffer;
}
export type RunAttachment = RunFile & { id: string };
export class RunError extends Error {}

const allowedInputs = new Map<string, number>([
  ...['image/png', 'image/jpeg', 'image/webp'].map((mime): [string, number] => [mime, 20_000_000]),
  ...[
    'audio/flac',
    'audio/mpeg',
    'audio/mp4',
    'video/mp4',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
    'video/webm',
  ].map((mime): [string, number] => [mime, 25_000_000]),
  ['text/plain', 1_000_000],
]);

export function validateAttachment(file: RunAttachment) {
  const limit = allowedInputs.get(file.mimeType);
  if (!limit || !file.bytes.length || file.bytes.length > limit)
    throw new RunError('An attachment exceeds its limit or uses an unsupported file format.');
  if (file.mimeType === 'text/plain') {
    try {
      if (new TextDecoder('utf-8', { fatal: true }).decode(file.bytes).includes('\0'))
        throw new Error();
    } catch {
      throw new RunError('Attach a UTF-8 text file.');
    }
  }
}

type AssetRun = {
  files: Map<string, RunAttachment>;
  results: Map<string, RunFile>;
  active: boolean;
  expiry?: ReturnType<typeof setTimeout>;
  bytes: number;
};

@Injectable()
export class RunAssets implements OnModuleDestroy {
  private readonly runs = new Map<string, AssetRun>();

  private remove(id: string) {
    clearTimeout(this.runs.get(id)?.expiry);
    this.runs.delete(id);
  }

  private expire(id: string, run: AssetRun) {
    clearTimeout(run.expiry);
    run.expiry = setTimeout(() => this.remove(id), 30_000);
    run.expiry.unref();
  }

  onModuleDestroy() {
    for (const id of this.runs.keys()) this.remove(id);
  }

  stage(id: string, files: RunAttachment[]) {
    if (this.runs.has(id)) throw new RunError('This request ID is already in use.');
    if (this.runs.size >= conductorLimits.turns * 2)
      throw new RunError('Too many staged requests. Try again shortly.');
    const bytes = files.reduce((total, file) => total + file.bytes.length, 0);
    if (
      files.length > 4 ||
      bytes > conductorLimits.attachmentBytes ||
      new Set(files.map((file) => file.id)).size !== files.length
    )
      throw new RunError('Attach up to four files within the total attachment limit.');
    files.forEach(validateAttachment);
    const staged = {
      files: new Map(files.map((file) => [file.id, file])),
      results: new Map<string, RunFile>(),
      active: false,
      bytes: 0,
    };
    this.runs.set(id, staged);
    this.expire(id, staged);
  }

  begin(id: string, ids: string[]) {
    if (!this.runs.has(id) && !ids.length) this.stage(id, []);
    const run = this.runs.get(id);
    if (!run || run.active || run.files.size !== ids.length || ids.some((id) => !run.files.has(id)))
      throw new RunError(
        'The request attachments are unavailable or the request is already active.',
      );
    clearTimeout(run.expiry);
    run.active = true;
    return run.files;
  }

  put(runId: string, file: RunFile): ArtifactReference {
    const run = this.runs.get(runId);
    if (
      !run?.active ||
      run.results.size >= conductorLimits.artifacts ||
      !file.bytes.length ||
      run.bytes + file.bytes.length > conductorLimits.artifactBytes
    )
      throw new RunError('The result exceeds the run’s artifact limit.');
    const id = randomUUID();
    const name = basename(file.name.replaceAll('\\', '/')).slice(0, 255);
    run.results.set(id, { ...file, name });
    run.bytes += file.bytes.length;
    return { id, name, mimeType: file.mimeType, size: file.bytes.length };
  }

  get(runId: string, id: string) {
    return this.runs.get(runId)?.results.get(id);
  }

  finish(id: string) {
    const run = this.runs.get(id);
    if (!run) return;
    if (!run.results.size) this.remove(id);
    else {
      run.files.clear();
      run.active = false;
      this.expire(id, run);
    }
  }

  release(id: string) {
    if (!this.runs.get(id)?.active) this.remove(id);
  }
}
