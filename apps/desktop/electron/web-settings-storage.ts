import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  defaultWebPolicy,
  webPolicySchema,
  webSettingsInputSchema,
  type WebSettings,
  type RuntimeWeb,
} from '@aria/shared';
import { z } from 'zod';

const legacySchema = webPolicySchema.extend({
  version: z.literal(1),
  revision: z.string().uuid(),
});
const schema = webPolicySchema.extend({
  version: z.literal(2),
  revision: z.string().uuid(),
});
type Record = z.infer<typeof schema>;

export async function writeBrowserJson(file: string, data: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export class WebSettingsStorage {
  private readonly file: string;
  private data: Record = { ...defaultWebPolicy, version: 2, revision: randomUUID() };
  private warning?: string;
  constructor(directory: string) {
    this.file = path.join(directory, 'web-settings-v1.json');
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const current = schema.safeParse(raw);
      if (current.success) {
        this.data = current.data;
        return;
      }
      const legacy = legacySchema.strip().safeParse(raw);
      if (legacy.success) {
        // Upgrade v1 ceiling defaults (2 searches / 4 fetches) while keeping any lower user limits.
        this.data = {
          ...legacy.data,
          searches:
            legacy.data.searches === 2 ? defaultWebPolicy.searches : legacy.data.searches,
          fetches: legacy.data.fetches === 4 ? defaultWebPolicy.fetches : legacy.data.fetches,
          version: 2,
          revision: randomUUID(),
        };
      } else {
        this.data = schema.strip().parse(raw);
      }
      // Rewrite old web settings without obsolete fields or legacy version ceilings.
      await writeBrowserJson(this.file, this.data).catch(() => {
        this.warning =
          'Old search settings could not be removed from disk. Save Web & Browser to try again.';
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      await fs.copyFile(this.file, `${this.file}.recovery-${Date.now()}`).catch(() => undefined);
      this.warning = 'Web settings could not be read. Review and save your choices.';
      this.data = { ...this.data, enabled: false };
    }
  }

  get revision() {
    return this.data.revision;
  }

  get(): WebSettings {
    const policy = webPolicySchema.strip().parse(this.data);
    return { ...policy, warning: this.warning };
  }

  async runtime(): Promise<RuntimeWeb> {
    return webPolicySchema.strip().parse(this.data);
  }

  async save(input: unknown) {
    const policy = webSettingsInputSchema.parse(input);
    const next: Record = { ...policy, version: 2, revision: randomUUID() };
    await writeBrowserJson(this.file, next);
    this.data = next;
    this.warning = undefined;
    return this.get();
  }
}
