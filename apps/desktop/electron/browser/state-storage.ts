import { promises as fs } from 'node:fs';
import path from 'node:path';
import { webUrlSchema } from '@aria/shared';
import { z } from 'zod';
import { writeBrowserJson } from '../web-settings-storage';

const entry = z.strictObject({
  url: webUrlSchema,
  title: z.string().max(300),
  at: z.number().int(),
});
const schema = z.strictObject({
  version: z.literal(1),
  history: z.array(entry).max(1000),
  bookmarks: z.array(entry).max(500),
  tabs: z.array(webUrlSchema).max(12),
  selected: z.number().int().min(-1).max(11),
});
export type BrowserDiskState = z.infer<typeof schema>;

export class BrowserStateStorage {
  private readonly file: string;
  private writes = Promise.resolve();
  warning?: string;
  constructor(directory: string) {
    this.file = path.join(directory, 'browser-state-v1.json');
  }

  async read(): Promise<BrowserDiskState> {
    try {
      return schema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warning =
          'Browser history could not be read. A recovery copy was saved when possible.';
        await fs.copyFile(this.file, `${this.file}.recovery-${Date.now()}`).catch(() => undefined);
      }
      return { version: 1, history: [], bookmarks: [], tabs: [], selected: -1 };
    }
  }

  save(state: BrowserDiskState) {
    const snapshot = schema.parse(state);
    const save = this.writes.then(() => writeBrowserJson(this.file, snapshot));
    this.writes = save.catch(() => {
      this.warning = 'Browser changes could not be saved.';
    });
    return save;
  }

  flush() {
    return this.writes;
  }
}
