import { z } from 'zod';
import type { RuntimeRegistry, RuntimeSettings } from '@aria/shared';
import { RuntimeError, digest } from './store';

type Target = NonNullable<RuntimeSettings['embeddingTarget']>;
const responseSchema = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        embedding: z.array(z.number()).min(8).max(4096),
      }),
    )
    .min(1)
    .max(32),
});

function rejectionMessage(status: number) {
  const prefix = `The embedding provider returned HTTP ${status}.`;
  switch (status) {
    case 401:
    case 403:
      return `${prefix} Check the connection’s API key and access to the selected model.`;
    case 400:
    case 404:
    case 405:
    case 422:
      return `${prefix} Check that the configured endpoint supports /embeddings and the exact model ID.`;
    case 402:
      return `${prefix} Check the provider’s billing and credits.`;
    case 429:
      return `${prefix} Check the provider’s rate or usage limit, then retry.`;
    default:
      return `${prefix} Check the provider’s status and retry.`;
  }
}

export class RemoteEmbeddings {
  readonly origin: string;
  readonly revision: string;

  constructor(
    private readonly connection: RuntimeRegistry['connections'][number],
    private readonly model: string,
  ) {
    const url = new URL(connection.baseUrl);
    if (url.protocol !== 'https:')
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'Remote embeddings require a configured HTTPS provider.',
      );
    this.origin = url.origin;
    this.revision = digest(
      JSON.stringify([connection.id, connection.baseUrl, connection.apiKey, model]),
    );
  }

  static resolve(registry: RuntimeRegistry, target: Target) {
    const connection = registry.connections.find(
      (candidate) => candidate.id === target.connectionId,
    );
    if (
      !connection?.apiKey ||
      !connection.models.some((model) => model.enabled && model.id === target.model)
    )
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Select an enabled exact embedding model in AI Models and Tools.',
      );
    return new RemoteEmbeddings(connection, target.model);
  }

  async embed(texts: string[], signal: AbortSignal) {
    const timeout = AbortSignal.timeout(18_000);
    let bytes: Buffer;
    try {
      const response = await fetch(this.connection.baseUrl.replace(/\/+$/, '') + '/embeddings', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([signal, timeout]),
        headers: {
          Authorization: `Bearer ${this.connection.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: this.model, input: texts, encoding_format: 'float' }),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new RuntimeError('CAPABILITY_UNAVAILABLE', rejectionMessage(response.status));
      }
      bytes = await readEmbeddingResponse(response);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof RuntimeError) throw error;
      if (timeout.aborted)
        throw new RuntimeError('TIMEOUT', 'The embedding request timed out. Try again.');
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Could not reach the embedding provider. Check the HTTPS endpoint and your connection.',
      );
    }
    let result: unknown;
    try {
      result = JSON.parse(bytes.toString('utf8'));
    } catch {
      // Malformed JSON is handled like any other incompatible provider response.
    }
    const parsed = responseSchema.safeParse(result);
    if (!parsed.success)
      throw new RuntimeError(
        'EXECUTION_FAILED',
        'The provider returned an invalid embedding response. Check that the selected model returns numeric vectors.',
      );
    const { data } = parsed.data;
    data.sort((a, b) => a.index - b.index);
    if (
      data.length !== texts.length ||
      data.some(
        (item, index) => item.index !== index || item.embedding.length !== data[0].embedding.length,
      )
    )
      throw new RuntimeError(
        'EXECUTION_FAILED',
        'The embedding result does not match the requested input batch.',
      );
    return data.map((item) => item.embedding);
  }
}

async function readEmbeddingResponse(response: Response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, received);
      received += value.byteLength;
      if (received > 2_000_000)
        throw new RuntimeError('BUDGET_EXCEEDED', 'The embedding response exceeded its size limit.');
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
