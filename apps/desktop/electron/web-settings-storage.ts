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
import type { SecretCipher } from './provider-storage';

const schema = webPolicySchema.extend({
  version: z.literal(1),
  revision: z.string().uuid(),
  encryptedKey: z.string().max(64_000).optional(),
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
  private data: Record = { ...defaultWebPolicy, version: 1, revision: randomUUID() };
  private warning?: string;
  constructor(
    directory: string,
    private readonly cipher: SecretCipher,
  ) {
    this.file = path.join(directory, 'web-settings-v1.json');
  }

  async load() {
    try {
      this.data = schema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
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
    return { ...policy, hasKey: !!this.data.encryptedKey, warning: this.warning };
  }

  async runtime(): Promise<RuntimeWeb> {
    const policy = webPolicySchema.strip().parse(this.data);
    let braveKey: string | undefined;
    if (policy.enabled && policy.braveEnabled && this.data.encryptedKey) {
      try {
        if (!(await this.cipher.available())) throw new Error('Credential storage unavailable.');
        braveKey = (await this.cipher.decrypt(Buffer.from(this.data.encryptedKey!, 'base64')))
          .result;
      } catch {
        this.warning = 'Aria could not unlock the Brave key. Enter it again in Web & Browser.';
      }
    }
    return { ...policy, braveKey };
  }

  async save(input: unknown) {
    const { apiKey, ...policy } = webSettingsInputSchema.parse(input);
    let encryptedKey = this.data.encryptedKey;
    if (apiKey === null) encryptedKey = undefined;
    else if (apiKey) {
      if (!(await this.cipher.available()))
        throw new Error('Encrypted credential storage is unavailable.');
      encryptedKey = (await this.cipher.encrypt(apiKey)).toString('base64');
    }
    if (policy.braveEnabled && !encryptedKey)
      throw new Error('Enter a Brave Search API key first.');
    const next: Record = { ...policy, encryptedKey, version: 1, revision: randomUUID() };
    await writeBrowserJson(this.file, next);
    this.data = next;
    this.warning = undefined;
    return this.get();
  }
}
