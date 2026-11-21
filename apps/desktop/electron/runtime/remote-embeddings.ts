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
    const response = await fetch(this.connection.baseUrl.replace(/\/$/, '') + '/embeddings', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(18_000)]),
      headers: {
        Authorization: `Bearer ${this.connection.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, input: texts, encoding_format: 'float' }),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The configured provider rejected the embedding request.',
      );
    }
    const reader = response.body.getReader();
    const bytes: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > 2_000_000)
          throw new RuntimeError(
            'BUDGET_EXCEEDED',
            'The embedding response exceeded its size limit.',
          );
        bytes.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const { data } = responseSchema.parse(JSON.parse(Buffer.concat(bytes).toString('utf8')));
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
