import { z } from 'zod';

export const officialOpenAI = 'https://api.openai.com/v1';
export const modelCapabilities = [
  'chat',
  'tools',
  'vision',
  'image',
  'image-edit',
  'speech',
  'transcription',
  'live',
  'web-search',
] as const;
export const modelCapabilitySchema = z.enum(modelCapabilities);
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

export const identifier = z.string().min(1).max(200);
export const modelRefSchema = z.string().min(1).max(300);
export const modelReference = (connectionId: string, modelId: string) =>
  `${connectionId}:${modelId}`;
export const providerEndpointSchema = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['https:', 'http:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.origin !== 'https://api.openai.com' || url.pathname.replace(/\/+$/, '') === '/v1')
      );
    } catch {
      return false;
    }
  }, 'Enter a valid provider endpoint without credentials, query, or fragment.');
export const capabilityList = z.array(modelCapabilitySchema).max(modelCapabilities.length);

export const modelPolicySchema = z
  .object({
    id: identifier,
    enabled: z.boolean(),
    delegate: z.boolean(),
    declared: capabilityList,
  })
  .strict();
export const connectionSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    baseUrl: providerEndpointSchema,
    models: z.array(modelPolicySchema).max(200),
    webSearch: z.boolean(),
  })
  .strict()
  .superRefine((connection, context) => {
    if (new Set(connection.models.map((model) => model.id)).size !== connection.models.length)
      context.addIssue({ code: 'custom', message: 'Duplicate models in connection.' });
  });
export const registryPolicySchema = z
  .object({
    primary: modelRefSchema.nullable(),
    live: z
      .object({
        model: modelRefSchema,
        voice: z.enum([
          'marin',
          'cedar',
          'alloy',
          'ash',
          'ballad',
          'coral',
          'echo',
          'sage',
          'verse',
        ]),
      })
      .strict()
      .nullable(),
    systemPrompt: z.string().max(16000),
    preference: z.enum(['balanced', 'cost', 'latency', 'quality']),
    crossConnection: z.boolean(),
    crossConnectionAttachments: z.boolean(),
  })
  .strict();
export const connectionInputSchema = connectionSchema.safeExtend({
  apiKey: z.string().trim().max(16000).optional(),
  removeKey: z.boolean().optional(),
});
export const registryInputSchema = registryPolicySchema
  .extend({
    revision: z.string().max(100),
    connections: z.array(connectionInputSchema).max(12),
  })
  .strict();
export const runtimeRegistrySchema = registryPolicySchema
  .extend({
    revision: z.string().max(100),
    connections: z
      .array(
        connectionSchema.safeExtend({
          apiKey: z.string().max(16000),
          verified: z.array(identifier).max(200),
        }),
      )
      .max(12),
  })
  .strict();

export type ConnectionInput = z.infer<typeof connectionInputSchema>;
export type RegistryInput = z.infer<typeof registryInputSchema>;
export type RuntimeRegistry = z.infer<typeof runtimeRegistrySchema>;
export type RegistrySettings = Omit<RegistryInput, 'connections'> & {
  connections: (z.infer<typeof connectionSchema> & {
    keyConfigured: boolean;
    verified: string[];
    locked?: boolean;
  })[];
  environmentImportAvailable: boolean;
  encryptionAvailable: boolean;
};
export interface DiscoveredModel {
  id: string;
  capabilities: ModelCapability[];
  source: 'provider' | 'documentation' | 'unknown';
  transport?: 'realtime' | 'speech-api' | 'inline-png' | 'base64-image';
  voices?: string[];
  contextTokens?: number;
  inputCost?: number;
  outputCost?: number;
}
export const emptyRegistryPolicy: z.infer<typeof registryPolicySchema> = {
  primary: null,
  live: null,
  systemPrompt: '',
  preference: 'balanced',
  crossConnection: false,
  crossConnectionAttachments: false,
};

export function registryPolicyOf(value: z.infer<typeof registryPolicySchema>) {
  const { primary, live, systemPrompt, preference, crossConnection, crossConnectionAttachments } =
    value;
  return { primary, live, systemPrompt, preference, crossConnection, crossConnectionAttachments };
}

export function registryDraft(settings: RegistrySettings): RegistryInput {
  return {
    ...registryPolicyOf(settings),
    revision: settings.revision,
    connections: settings.connections.map(({ id, name, baseUrl, models, webSearch }) => ({
      id,
      name,
      baseUrl,
      models,
      webSearch,
    })),
  };
}
