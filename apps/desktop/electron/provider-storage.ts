import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  ProviderConnectionInput,
  ProviderSettings,
  ProviderSettingsInput,
} from '@aria/shared';

const endpoint = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, 'Enter an HTTP or HTTPS provider endpoint without credentials, a query, or a fragment.');
export const emptyModels = { chat: '', image: '', speech: '', transcription: '', live: '' };
const modelId = z.string().trim().max(200);
export const modelsSchema = z
  .object({ chat: modelId, image: modelId, speech: modelId, transcription: modelId, live: modelId })
  .strict();
export const providerConnectionSchema = z
  .object({
    provider: z.literal('openai'),
    baseUrl: endpoint,
    apiKey: z.string().trim().max(16000).optional(),
    removeKey: z.boolean().optional(),
  })
  .strict();
export const providerSettingsSchema = z
  .object({
    provider: z.literal('openai').default('openai'),
    baseUrl: endpoint,
    model: z.string().trim().max(200),
    models: modelsSchema.optional(),
    systemPrompt: z.string().max(16000),
    apiKey: z.string().trim().max(16000).optional(),
    removeKey: z.boolean().optional(),
  })
  .strict();
const storedSchema = providerSettingsSchema
  .omit({ apiKey: true, removeKey: true })
  .extend({ encryptedKey: z.string().max(64000).optional() });
export interface SecretCipher {
  available(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<{ result: string; shouldReEncrypt?: boolean }>;
}
export class ProviderConfigurationError extends Error {}
export class ProviderStorage {
  constructor(
    private readonly directory: string,
    private readonly cipher: SecretCipher,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}
  private async read() {
    try {
      return storedSchema.parse(
        JSON.parse(await fs.readFile(path.join(this.directory, 'provider.json'), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          provider: 'openai' as const,
          baseUrl: 'https://api.openai.com/v1',
          model: '',
          systemPrompt: '',
        };
      throw new ProviderConfigurationError(
        'Provider settings could not be read. Your saved file has been preserved.',
      );
    }
  }
  private async write(data: z.infer<typeof storedSchema>) {
    await fs.mkdir(this.directory, { recursive: true });
    const filename = path.join(this.directory, 'provider.json');
    await fs.writeFile(`${filename}.tmp`, JSON.stringify(data), { mode: 0o600 });
    await fs.rename(`${filename}.tmp`, filename);
  }
  async resolve(draft?: ProviderConnectionInput) {
    const stored = await this.read();
    if (draft) providerConnectionSchema.parse(draft);
    let apiKey = this.env.OPENAI_API_KEY?.trim() || draft?.apiKey?.trim() || '';
    if (!apiKey && stored.encryptedKey && !draft?.removeKey) {
      try {
        const value = await this.cipher.decrypt(Buffer.from(stored.encryptedKey, 'base64'));
        apiKey = value.result;
        if (value.shouldReEncrypt)
          await this.write({
            ...stored,
            encryptedKey: (await this.cipher.encrypt(apiKey)).toString('base64'),
          });
      } catch {
        throw new ProviderConfigurationError(
          'The saved API key could not be unlocked. Unlock your system credential store or replace the key.',
        );
      }
    }
    const baseUrl = this.env.OPENAI_BASE_URL?.trim() || draft?.baseUrl || stored.baseUrl;
    if (!endpoint.safeParse(baseUrl).success)
      throw new ProviderConfigurationError('The configured provider endpoint is invalid.');
    return {
      provider: 'openai' as const,
      baseUrl,
      model: this.env.OPENAI_MODEL?.trim() || stored.models?.chat || stored.model,
      models: {
        ...emptyModels,
        ...stored.models,
        chat: this.env.OPENAI_MODEL?.trim() || stored.models?.chat || stored.model,
      },
      systemPrompt: this.env.ARIA_SYSTEM_PROMPT?.trim()
        ? this.env.ARIA_SYSTEM_PROMPT
        : stored.systemPrompt,
      apiKey,
    };
  }
  async get(): Promise<ProviderSettings> {
    const stored = await this.read();
    return {
      provider: 'openai',
      baseUrl: this.env.OPENAI_BASE_URL?.trim() || stored.baseUrl,
      model: this.env.OPENAI_MODEL?.trim() || stored.models?.chat || stored.model,
      models: {
        ...emptyModels,
        ...stored.models,
        chat: this.env.OPENAI_MODEL?.trim() || stored.models?.chat || stored.model,
      },
      systemPrompt: this.env.ARIA_SYSTEM_PROMPT?.trim()
        ? this.env.ARIA_SYSTEM_PROMPT
        : stored.systemPrompt,
      keyConfigured: Boolean(this.env.OPENAI_API_KEY?.trim() || stored.encryptedKey),
      encryptionAvailable: await this.cipher.available(),
      sources: {
        baseUrl: this.env.OPENAI_BASE_URL?.trim()
          ? 'environment'
          : stored.baseUrl === 'https://api.openai.com/v1'
            ? 'default'
            : 'settings',
        model: this.env.OPENAI_MODEL?.trim()
          ? 'environment'
          : stored.model
            ? 'settings'
            : 'default',
        systemPrompt: this.env.ARIA_SYSTEM_PROMPT?.trim()
          ? 'environment'
          : stored.systemPrompt
            ? 'settings'
            : 'default',
        apiKey: this.env.OPENAI_API_KEY?.trim()
          ? 'environment'
          : stored.encryptedKey
            ? 'settings'
            : 'default',
      },
    };
  }
  async save(input: ProviderSettingsInput): Promise<ProviderSettings> {
    const parsed = providerSettingsSchema.parse(input);
    const stored = await this.read();
    let encryptedKey = stored.encryptedKey;
    if (!this.env.OPENAI_API_KEY?.trim()) {
      if (parsed.removeKey) encryptedKey = undefined;
      else if (parsed.apiKey) {
        if (!(await this.cipher.available()))
          throw new ProviderConfigurationError(
            'System encryption is unavailable. Unlock your credential store and try again.',
          );
        try {
          encryptedKey = (await this.cipher.encrypt(parsed.apiKey)).toString('base64');
        } catch {
          throw new ProviderConfigurationError(
            'The API key could not be encrypted. Your existing settings were preserved.',
          );
        }
      }
    }
    await this.write({
      provider: 'openai',
      baseUrl: parsed.baseUrl,
      model: parsed.models?.chat ?? parsed.model,
      models: parsed.models ?? { ...emptyModels, chat: parsed.model },
      systemPrompt: parsed.systemPrompt,
      ...(encryptedKey ? { encryptedKey } : {}),
    });
    return this.get();
  }
}
