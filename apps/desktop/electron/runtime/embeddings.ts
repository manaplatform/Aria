import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { BrowserWindow, app } from 'electron';
import { z } from 'zod';
import { RuntimeError } from './store';

export const embeddingRevision = 'minilm-2c4055b-mean-128-v1';
const modelFiles = {
  'tokenizer.json': {
    source: 'tokenizer.json',
    sha: 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441',
    max: 20_000_000,
  },
  'tokenizer_config.json': {
    source: 'tokenizer_config.json',
    sha: '3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2',
    max: 200_000,
  },
  'model_quantized.onnx': {
    source: 'onnx/model_quantized.onnx',
    sha: '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc',
    max: 118_308_126,
  },
} as const;
const weights = Object.entries(modelFiles);

async function verified(filename: string, checksum: string, max: number) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.size > max || stat.nlink !== 1) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex') === checksum;
}

export class LocalEmbeddings {
  private readonly root: string;
  private window?: BrowserWindow;
  private queue = Promise.resolve();
  private lastUsed?: ReturnType<typeof setTimeout>;

  constructor(profile: string) {
    this.root = path.join(profile, 'runtime-model', embeddingRevision);
  }

  async available() {
    return fs.access(path.join(this.root, 'model_quantized.onnx')).then(
      () => true,
      () => false,
    );
  }

  async install(source: string) {
    const parent = path.dirname(this.root);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const temp = await fs.mkdtemp(path.join(parent, 'pending-'));
    try {
      for (const [name, file] of weights) {
        const original = path.join(source, file.source);
        const stat = await fs.lstat(original);
        if (!stat.isFile() || !stat.size || stat.size > file.max)
          throw new Error(`${file.source} exceeds the model pack limits.`);
        const destination = path.join(temp, name);
        await fs.copyFile(original, destination);
        if (!(await verified(destination, file.sha, file.max)))
          throw new Error(`${file.source} does not match the pinned version.`);
      }
      this.close();
      await fs.rm(this.root, { recursive: true, force: true });
      await fs.rename(temp, this.root);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }

  async remove() {
    this.close();
    await fs.rm(this.root, { recursive: true, force: true });
  }

  close() {
    clearTimeout(this.lastUsed);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined;
  }

  private async boot() {
    for (const [name, file] of weights) {
      if (!(await verified(path.join(this.root, name), file.sha, file.max).catch(() => false)))
        throw new RuntimeError(
          'CAPABILITY_UNAVAILABLE',
          'Install the verified local embedding pack in Tools settings.',
        );
    }
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: `aria-embedding-${randomUUID()}`,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        devTools: false,
      },
    });
    this.window = window;
    const web = window.webContents;
    web.setWindowOpenHandler(() => ({ action: 'deny' }));
    web.on('will-navigate', (event) => event.preventDefault());
    const partition = web.session;
    partition.setPermissionRequestHandler((_contents, _permission, done) => done(false));
    partition.setPermissionCheckHandler(() => false);
    partition.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    );
    partition.protocol.handle('aria-embedding-pack', (request) => {
      const url = new URL(request.url);
      const name = url.pathname.slice(1);
      if (
        request.method !== 'GET' ||
        url.hostname !== 'bundle' ||
        url.search ||
        url.hash ||
        !Object.hasOwn(modelFiles, name)
      )
        return new Response(null, { status: 404 });
      const stream = Readable.toWeb(
        createReadStream(path.join(this.root, name)),
      ) as unknown as ReadableStream<Uint8Array>;
      return new Response(stream, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        },
      });
    });
    await window.loadFile(path.resolve(__dirname, '../../dist/extraction.html'));
    return window;
  }

  embed(texts: string[], signal: AbortSignal): Promise<number[][]> {
    if (!texts.length || texts.length > 32 || texts.some((text) => text.length > 1500))
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        'The embedding input exceeds its batch or text limit.',
      );
    const operation = this.queue.then(async () => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
      deadline.throwIfAborted();
      const close = () => this.close();
      deadline.addEventListener('abort', close, { once: true });
      clearTimeout(this.lastUsed);
      const memory = setInterval(() => {
        const web = this.window?.webContents;
        if (
          web &&
          !web.isDestroyed() &&
          (app.getAppMetrics().find((process) => process.pid === web.getOSProcessId())?.memory
            .workingSetSize ?? 0) > 700_000
        )
          this.close();
      }, 500);
      try {
        const window = this.window ?? (await this.boot());
        deadline.throwIfAborted();
        return z
          .array(z.array(z.number().min(-1).max(1)).length(384))
          .length(texts.length)
          .parse(
            await window.webContents.executeJavaScript(
              `window.embedDocuments(${JSON.stringify(texts)})`,
            ),
          );
      } catch (error) {
        this.close();
        throw error;
      } finally {
        clearInterval(memory);
        deadline.removeEventListener('abort', close);
        if (this.window) {
          this.lastUsed = setTimeout(close, 120_000);
          this.lastUsed.unref();
        }
      }
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
