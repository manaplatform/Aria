import { jsonSchema, tool, type JSONSchema7, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { capabilityId, type ToolDiscovery } from '@aria/shared';
import { nativeToolSearch } from './ai.service';

const selection = z.strictObject({ ids: z.array(capabilityId).min(1).max(4) });

interface Definition {
  id: string;
  name: string;
  description: string;
  schema: JSONSchema7;
  deferred: boolean;
}

type DiscoveryProtocol = {
  name: string;
  apiTool: ToolSet[string];
  resultFormat: 'text' | 'json';
  definition(input: Definition): ToolSet[string];
  selection(input: unknown, callId: string): string[];
  result(definitions: Definition[]): object;
  emptyResult?: object;
  prune(messages: ModelMessage[], revoked: Set<string>): void;
  accepts(id: string, metadata: unknown): boolean;
  supports(baseUrl: string, verified: boolean): boolean;
  rejected(error: unknown): boolean;
};

const openAIEnvelope = z.object({ openai: z.object({ namespace: z.string() }) });
const namespaceOf = (id: string) => id.split('.')[0];

const aria: DiscoveryProtocol = {
  name: 'load_capabilities',
  apiTool: tool({
    description: 'Load selected tool schemas by discovered ID.',
    inputSchema: selection,
  }),
  resultFormat: 'text',
  definition: (item) =>
    tool({ description: item.description, inputSchema: jsonSchema(item.schema), strict: false }),
  selection: (input) => selection.parse(input).ids,
  result: (items) => ({ loaded: items.map(({ id, name }) => ({ id, name })) }),
  prune() {},
  accepts: () => true,
  supports: () => true,
  rejected: () => false,
};

const responses: DiscoveryProtocol = {
  name: 'tool_search',
  apiTool: nativeToolSearch(z.toJSONSchema(selection)),
  resultFormat: 'json',
  definition: (item) =>
    tool({
      description: item.description,
      inputSchema: jsonSchema(item.schema),
      strict: false,
      providerOptions: { openai: { omitFromRequestTools: true } },
    }),
  selection: (input, callId) =>
    z.strictObject({ arguments: selection, call_id: z.literal(callId) }).parse(input).arguments.ids,
  result(items) {
    const namespaces = new Map<
      string,
      { type: 'namespace'; name: string; description: string; tools: object[] }
    >();
    for (const item of items) {
      const name = namespaceOf(item.id);
      const namespace = namespaces.get(name) ?? {
        type: 'namespace',
        name,
        description: `Aria ${name} capabilities`,
        tools: [],
      };
      namespace.tools.push({
        type: 'function',
        name: item.name,
        description: item.description,
        parameters: item.schema,
        strict: false,
        defer_loading: item.deferred,
      });
      namespaces.set(name, namespace);
    }
    return { tools: [...namespaces.values()] };
  },
  emptyResult: { tools: [] },
  prune(messages, revoked) {
    // Preserve client search call/result pairs while removing revoked schemas.
    for (const message of messages) {
      if (message.role !== 'tool') continue;
      for (const part of message.content) {
        if (
          part.type !== 'tool-result' ||
          part.toolName !== 'tool_search' ||
          part.output.type !== 'json'
        )
          continue;
        const result = part.output.value as { tools: { tools: { name: string }[] }[] };
        for (const namespace of result.tools)
          namespace.tools = namespace.tools.filter((item) => !revoked.has(item.name));
        result.tools = result.tools.filter((namespace) => namespace.tools.length);
      }
    }
  },
  accepts(id, metadata) {
    const envelope = openAIEnvelope.safeParse(metadata);
    return envelope.success && envelope.data.openai.namespace === namespaceOf(id);
  },
  supports: (baseUrl, verified) => verified && new URL(baseUrl).origin === 'https://api.openai.com',
  rejected: (error) =>
    Boolean(
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      [400, 404, 422].some((code) => code === error.statusCode),
    ),
};

export function discoveryProtocol(mode: ToolDiscovery): DiscoveryProtocol {
  return mode === 'openai-responses' ? responses : aria;
}
