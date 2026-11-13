import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  connectionSchema,
  emptyRegistryPolicy,
  identifier,
  modelReference,
  officialOpenAI,
  providerEndpointSchema,
  registryInputSchema,
  registryPolicyOf,
  registryPolicySchema,
  type ConnectionInput,
  type DiscoveredModel,
  type ModelCapability,
  type RegistryInput,
  type RegistrySettings,
  type RuntimeRegistry,
} from '@aria/shared';

const legacyModels = z.object({
  chat: z.string(),
  image: z.string(),
  speech: z.string(),
  transcription: z.string(),
  live: z.string(),
});
const legacySchema = z.object({
  // Original provider.json files predate provider selection and always used OpenAI's protocol.
  provider: z.literal('openai').default('openai'),
  baseUrl: providerEndpointSchema,
  model: z.string(),
  models: legacyModels.optional(),
  systemPrompt: z.string(),
  encryptedKey: z.string().max(64000).optional(),
});
const savedConnection = connectionSchema.safeExtend({
  encryptedKey: z.string().max(64000).optional(),
  verified: z.array(identifier).max(200),
});
const savedRegistry = registryPolicySchema
  .extend({
    version: z.literal(2),
    revision: z.string(),
    connections: z.array(savedConnection).max(12),
    environmentImported: z.boolean(),
  })
  .strict();
type SavedRegistry = z.infer<typeof savedRegistry>;
type SavedConnection = z.infer<typeof savedConnection>;

export interface SecretCipher {
  available(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<{ result: string; shouldReEncrypt?: boolean }>;
}
export class ProviderConfigurationError extends Error {}

export class ProviderStorage {
  private readonly proofs = new Map<string, number>();
  private queue = Promise.resolve();
  constructor(
    private readonly directory: string,
    private readonly cipher: SecretCipher,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async read(): Promise<SavedRegistry> {
    try {
      return savedRegistry.parse(
        JSON.parse(await fs.readFile(path.join(this.directory, 'provider-v2.json'), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new ProviderConfigurationError(
          'AI Models settings could not be read. The saved file was preserved.',
        );
    }
    const blank: SavedRegistry = {
      ...emptyRegistryPolicy,
      version: 2,
      revision: randomUUID(),
      connections: [],
      environmentImported: false,
    };
    try {
      const legacy = legacySchema.parse(
        JSON.parse(await fs.readFile(path.join(this.directory, 'provider.json'), 'utf8')),
      );
      const id = randomUUID();
      const policies = new Map<string, ModelCapability[]>();
      const defaults = legacy.models ?? {
        chat: legacy.model,
        image: '',
        speech: '',
        transcription: '',
        live: '',
      };
      for (const [operation, model] of Object.entries(defaults) as [ModelCapability, string][]) {
        if (!model) continue;
        const declared = policies.get(model) ?? [];
        declared.push(operation);
        if (operation === 'image') declared.push('image-edit');
        policies.set(model, declared);
      }
      const primary = defaults.chat || legacy.model;
      blank.primary = primary ? modelReference(id, primary) : null;
      blank.live = defaults.live
        ? { model: modelReference(id, defaults.live), voice: 'marin' }
        : null;
      blank.systemPrompt = legacy.systemPrompt;
      blank.connections = [
        {
          id,
          name: 'OpenAI',
          baseUrl: legacy.baseUrl,
          encryptedKey: legacy.encryptedKey,
          verified: [],
          webSearch: false,
          models: [...policies].map(([model, declared]) => ({
            id: model,
            enabled: true,
            delegate: true,
            declared,
          })),
        },
      ];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new ProviderConfigurationError(
          'Legacy model settings could not be migrated. The saved file was preserved.',
        );
    }
    await this.write(blank);
    return blank;
  }

  private async write(data: SavedRegistry) {
    const checked = savedRegistry.parse(data);
    await fs.mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, 'provider-v2.json');
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(checked), { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  private async decrypt(connection?: SavedConnection) {
    if (!connection?.encryptedKey) return '';
    try {
      return (await this.cipher.decrypt(Buffer.from(connection.encryptedKey, 'base64'))).result;
    } catch {
      throw new ProviderConfigurationError(
        'The saved key could not be unlocked. Unlock your credential store or replace the key.',
      );
    }
  }

  private async encrypt(key: string) {
    try {
      if (!(await this.cipher.available())) throw new Error();
      return (await this.cipher.encrypt(key)).toString('base64');
    } catch {
      throw new ProviderConfigurationError(
        'The API key could not be encrypted. Your existing settings were preserved.',
      );
    }
  }

  private async publicSettings(saved: SavedRegistry): Promise<RegistrySettings> {
    const { environmentImported, connections, revision } = saved;
    return {
      ...registryPolicyOf(saved),
      revision,
      encryptionAvailable: await this.cipher.available(),
      environmentImportAvailable:
        !environmentImported &&
        Boolean(
          this.env.OPENAI_MODEL?.trim() ||
          this.env.OPENAI_API_KEY?.trim() ||
          this.env.OPENAI_BASE_URL?.trim() ||
          this.env.ARIA_SYSTEM_PROMPT?.trim(),
        ),
      connections: await Promise.all(
        connections.map(async ({ encryptedKey, ...connection }) => ({
          ...connection,
          keyConfigured: Boolean(encryptedKey),
          locked:
            Boolean(encryptedKey) &&
            !(await this.decrypt({ ...connection, encryptedKey }).catch(() => '')),
        })),
      ),
    };
  }

  get() {
    return this.serialize(async () => this.publicSettings(await this.read()));
  }

  resolve(): Promise<RuntimeRegistry> {
    return this.serialize(async () => {
      const saved = await this.read();
      return {
        ...registryPolicyOf(saved),
        revision: saved.revision,
        connections: await Promise.all(
          saved.connections.map(async ({ encryptedKey, ...connection }) => ({
            ...connection,
            apiKey: await this.decrypt({ ...connection, encryptedKey }).catch(() => ''),
          })),
        ),
      };
    });
  }

  private async draftKey(input: ConnectionInput, current?: SavedConnection) {
    if (input.removeKey) return '';
    if (input.apiKey) return input.apiKey;
    return current && new URL(input.baseUrl).href === new URL(current.baseUrl).href
      ? this.decrypt(current)
      : '';
  }

  private fingerprint(input: Pick<ConnectionInput, 'id' | 'baseUrl'>, key: string, model: string) {
    return createHash('sha256')
      .update(JSON.stringify([input.id, new URL(input.baseUrl).href, key, model]))
      .digest('hex');
  }

  async preview(input: ConnectionInput) {
    const current = await this.serialize(async () =>
      (await this.read()).connections.find((item) => item.id === input.id),
    );
    const key = await this.draftKey(input, current);
    if (!key) throw new ProviderConfigurationError('Enter an API key for this connection.');
    return { provider: 'openai' as const, baseUrl: input.baseUrl, apiKey: key };
  }

  markVerified(input: ConnectionInput, apiKey: string, model: string) {
    for (const [proof, expires] of this.proofs)
      if (expires <= Date.now()) this.proofs.delete(proof);
    if (this.proofs.size >= 200) this.proofs.delete(this.proofs.keys().next().value!);
    this.proofs.set(this.fingerprint(input, apiKey, model), Date.now() + 900_000);
  }

  save(
    input: RegistryInput,
    discover: (connection: {
      provider: 'openai';
      baseUrl: string;
      apiKey: string;
    }) => Promise<DiscoveredModel[]>,
  ) {
    return this.serialize(async () => {
      const parsed = registryInputSchema.parse(input);
      const current = await this.read();
      if (parsed.revision !== current.revision)
        throw new ProviderConfigurationError(
          'AI Models settings changed. Reload Settings and try again.',
        );
      if (new Set(parsed.connections.map((item) => item.id)).size !== parsed.connections.length)
        throw new ProviderConfigurationError('Connections must have unique IDs.');
      const { connections, ...policy } = parsed;
      const saved = await Promise.all(
        connections.map(async (input): Promise<SavedConnection> => {
          const prior = current.connections.find((item) => item.id === input.id);
          const { apiKey, removeKey, ...connection } = input;
          const sameEndpoint = Boolean(
            prior && new URL(prior.baseUrl).href === new URL(input.baseUrl).href,
          );
          const credentialChanged = Boolean(apiKey || removeKey || !sameEndpoint);
          const relevant = input.models.filter((model) => model.enabled);
          const newEnabled = relevant.some(
            (model) =>
              !sameEndpoint || !prior?.models.some((old) => old.id === model.id && old.enabled),
          );
          const primary = relevant.find(
            (model) => modelReference(input.id, model.id) === policy.primary,
          );
          const live = relevant.find(
            (model) => modelReference(input.id, model.id) === policy.live?.model,
          );
          const primaryChanged = Boolean(
            primary &&
            (credentialChanged ||
              current.primary !== policy.primary ||
              JSON.stringify(prior?.models.find((old) => old.id === primary.id)?.declared) !==
                JSON.stringify(primary.declared)),
          );
          const liveChanged = Boolean(
            live &&
            (credentialChanged || JSON.stringify(current.live) !== JSON.stringify(policy.live)),
          );
          const needsCatalog =
            newEnabled ||
            primaryChanged ||
            liveChanged ||
            (credentialChanged && !removeKey && relevant.length > 0);
          const key = needsCatalog
            ? await this.draftKey(input, prior)
            : await this.draftKey(input, prior).catch(() => '');
          const catalog =
            needsCatalog && key
              ? await discover({ provider: 'openai', baseUrl: input.baseUrl, apiKey: key })
              : [];
          const verified = input.models
            .filter(
              (model) =>
                (!credentialChanged && prior?.verified.includes(model.id)) ||
                (key &&
                  (this.proofs.get(this.fingerprint(input, key, model.id)) ?? 0) > Date.now()),
            )
            .map((model) => model.id);
          if (needsCatalog && !removeKey) {
            for (const model of relevant) {
              if (catalog.some((entry) => entry.id === model.id)) continue;
              if (
                !credentialChanged &&
                prior?.models.some((old) => old.id === model.id && old.enabled) &&
                (!primaryChanged || primary?.id !== model.id) &&
                (!liveChanged || live?.id !== model.id)
              )
                continue;
              throw new ProviderConfigurationError(
                `Model ${model.id} was not discovered on this connection.`,
              );
            }
          }
          if (primaryChanged && !removeKey && primary) {
            const found = catalog.find((item) => item.id === primary.id);
            const capabilities =
              found?.source === 'unknown' ? primary.declared : found?.capabilities;
            if (
              !capabilities?.includes('chat') ||
              !capabilities.includes('tools') ||
              (found?.source === 'unknown' && !verified.includes(primary.id))
            )
              throw new ProviderConfigurationError(
                'The primary needs streaming text and function calling. Verify unknown capabilities first.',
              );
          }
          if (liveChanged && !removeKey && live) {
            const found = catalog.find((item) => item.id === live.id);
            const capabilities = found?.source === 'unknown' ? live.declared : found?.capabilities;
            if (
              !capabilities?.includes('live') ||
              (found?.voices && !found.voices.includes(policy.live!.voice))
            )
              throw new ProviderConfigurationError(
                'Select a compatible Live Voice model and voice.',
              );
          }
          return {
            ...connection,
            verified,
            encryptedKey: removeKey
              ? undefined
              : apiKey
                ? await this.encrypt(apiKey)
                : sameEndpoint
                  ? prior?.encryptedKey
                  : undefined,
          };
        }),
      );
      const enabled = new Set(
        saved.flatMap((connection) =>
          connection.models
            .filter((model) => model.enabled)
            .map((model) => modelReference(connection.id, model.id)),
        ),
      );
      if (
        (policy.primary && !enabled.has(policy.primary)) ||
        (policy.live && !enabled.has(policy.live.model))
      )
        throw new ProviderConfigurationError(
          'The primary and Live Voice profile must reference enabled models.',
        );
      const next: SavedRegistry = {
        ...current,
        ...policy,
        revision: randomUUID(),
        connections: saved,
      };
      await this.write(next);
      return this.publicSettings(next);
    });
  }

  importEnvironment() {
    return this.serialize(async () => {
      const current = await this.read();
      if (current.environmentImported || current.connections.length >= 12)
        throw new ProviderConfigurationError('Environment import is unavailable.');
      const model = this.env.OPENAI_MODEL?.trim();
      const key = this.env.OPENAI_API_KEY?.trim();
      const baseUrl = providerEndpointSchema.parse(
        this.env.OPENAI_BASE_URL?.trim() || officialOpenAI,
      );
      const id = randomUUID();
      const candidate = model && modelReference(id, model);
      const next: SavedRegistry = {
        ...current,
        revision: randomUUID(),
        environmentImported: true,
        systemPrompt: current.systemPrompt || this.env.ARIA_SYSTEM_PROMPT || '',
        primary: current.primary || candidate || null,
        connections: [
          ...current.connections,
          {
            id,
            name: 'Imported connection',
            baseUrl,
            webSearch: false,
            verified: [],
            encryptedKey: key ? await this.encrypt(key) : undefined,
            models: model ? [{ id: model, enabled: true, delegate: true, declared: ['chat'] }] : [],
          },
        ],
      };
      await this.write(next);
      return this.publicSettings(next);
    });
  }
}
