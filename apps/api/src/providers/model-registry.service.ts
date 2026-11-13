import { Inject, Injectable } from '@nestjs/common';
import {
  emptyRegistryPolicy,
  modelCapabilitySchema,
  modelReference,
  officialOpenAI,
  runtimeRegistrySchema,
  type DiscoveredModel,
  type ModelCapability,
  type RuntimeRegistry,
} from '@aria/shared';
import { ProvidersService, type Connection } from './providers.service';

const standaloneId = '00000000-0000-4000-8000-000000000001';
export type RuntimeConnection = RuntimeRegistry['connections'][number];
export type ResolvedModel = DiscoveredModel & {
  ref: string;
  connection: RuntimeConnection;
  delegate: boolean;
  primaryEligible: boolean;
};
export class ConfigurationError extends Error {}

export function standaloneRegistry(env = process.env): RuntimeRegistry {
  const model = env.OPENAI_MODEL?.trim();
  const declared = (env.ARIA_MODEL_CAPABILITIES || '')
    .split(',')
    .map((value) => modelCapabilitySchema.safeParse(value.trim()))
    .flatMap((item) => (item.success ? [item.data] : []));
  return {
    ...emptyRegistryPolicy,
    revision: 'standalone',
    primary: model ? modelReference(standaloneId, model) : null,
    systemPrompt: env.ARIA_SYSTEM_PROMPT || '',
    connections: [
      {
        id: standaloneId,
        name: 'Standalone',
        baseUrl: env.OPENAI_BASE_URL || officialOpenAI,
        apiKey: env.OPENAI_API_KEY || '',
        models: model ? [{ id: model, enabled: true, delegate: false, declared }] : [],
        verified: declared.includes('tools') && model ? [model] : [],
        webSearch: false,
      },
    ],
  };
}

export const officialConnection = (baseUrl: string) =>
  new URL(baseUrl).origin === 'https://api.openai.com';
export const providerConnection = (
  config: Pick<RuntimeConnection, 'baseUrl' | 'apiKey'>,
): Connection => ({ provider: 'openai', baseUrl: config.baseUrl, apiKey: config.apiKey });

export function capabilitiesFor(
  connection: Pick<RuntimeConnection, 'baseUrl'>,
  discovered: DiscoveredModel,
  declared: ModelCapability[],
): ModelCapability[] {
  const supported = declared.filter(
    (capability) =>
      capability !== 'web-search' &&
      (capability !== 'live' || !officialConnection(connection.baseUrl)),
  );
  return discovered.source === 'unknown' ? [...new Set(supported)] : discovered.capabilities;
}

@Injectable()
export class ModelRegistry {
  private snapshot?: RuntimeRegistry;

  constructor(@Inject(ProvidersService) private readonly providers: ProvidersService) {}

  install(input: unknown) {
    this.snapshot = runtimeRegistrySchema.parse(input);
  }

  configuration() {
    return this.snapshot ?? standaloneRegistry();
  }

  status() {
    const snapshot = this.configuration();
    const primary = snapshot.connections.find(
      (connection) =>
        connection.apiKey &&
        connection.models.some(
          (model) => model.enabled && modelReference(connection.id, model.id) === snapshot.primary,
        ),
    );
    return {
      configured: Boolean(primary),
      model:
        primary?.models.find((model) => modelReference(primary.id, model.id) === snapshot.primary)
          ?.id || '',
      streaming: true as const,
      cancellation: true as const,
      attachments: true,
      revision: snapshot.revision,
      voiceReady: Boolean(
        primary &&
        snapshot.live &&
        snapshot.connections.some(
          (connection) =>
            connection.apiKey &&
            (snapshot.crossConnection || connection.id === primary.id) &&
            connection.models.some(
              (model) =>
                model.enabled && modelReference(connection.id, model.id) === snapshot.live?.model,
            ),
        ),
      ),
    };
  }

  async resolve(signal: AbortSignal, config = this.configuration(), includeLive = false) {
    const primaryConnection = config.connections.find((connection) =>
      connection.models.some(
        (model) => model.enabled && modelReference(connection.id, model.id) === config.primary,
      ),
    );
    if (!primaryConnection?.apiKey)
      throw new ConfigurationError(
        'Select an enabled primary model and configure its API key in Settings → AI Models.',
      );
    const connections = config.connections.filter(
      (connection) =>
        connection.apiKey &&
        (connection.id === primaryConnection.id || config.crossConnection) &&
        (connection.id === primaryConnection.id ||
          connection.models.some(
            (model) =>
              model.enabled &&
              (model.delegate ||
                (includeLive && modelReference(connection.id, model.id) === config.live?.model)),
          )),
    );
    const catalogs = await Promise.all(
      connections.map(async (connection) => {
        try {
          return await this.providers.discover(providerConnection(connection), false, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (connection.id === primaryConnection.id)
            throw new ConfigurationError(
              error instanceof Error ? error.message : 'Primary catalog unavailable.',
            );
          return [];
        }
      }),
    );
    const models = new Map<string, ResolvedModel>();
    for (const [index, connection] of connections.entries()) {
      const catalog = new Map(catalogs[index].map((model) => [model.id, model]));
      for (const policy of connection.models) {
        const descriptor = catalog.get(policy.id);
        if (!descriptor || !policy.enabled) continue;
        const capabilities = capabilitiesFor(connection, descriptor, policy.declared);
        const ref = modelReference(connection.id, policy.id);
        models.set(ref, {
          ...descriptor,
          ref,
          connection,
          capabilities,
          delegate: policy.delegate,
          primaryEligible:
            capabilities.includes('chat') &&
            capabilities.includes('tools') &&
            (descriptor.source !== 'unknown' || connection.verified.includes(policy.id)),
        });
      }
    }
    const primary = config.primary ? models.get(config.primary) : undefined;
    if (!primary?.primaryEligible)
      throw new ConfigurationError(
        'The primary model is unavailable or its tool calling is unverified. Review it in Settings → AI Models.',
      );
    return { primary, models, config };
  }
}
