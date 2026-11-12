import { z } from 'zod';
import {
  activitySchema,
  artifactReferenceSchema,
  runInfoSchema,
  type ChatEvent,
} from '@aria/shared';

const id = z.string().min(1).max(200);
export const chatRequestSchema = z
  .object({
    requestId: id,
    conversationId: id,
    assistantMessageId: id,
    attachmentIds: z.array(z.string().uuid()).max(4).optional(),
    expectedRevision: z.string().max(100).optional(),
    messages: z
      .array(
        z
          .object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(100000) })
          .strict(),
      )
      .min(1)
      .max(41),
  })
  .strict()
  .refine(
    (request) =>
      new Set(request.attachmentIds).size === (request.attachmentIds?.length ?? 0) &&
      request.messages.at(-1)?.role === 'user' &&
      request.messages.every((message) => message.content.trim()) &&
      request.messages.reduce((sum, message) => sum + message.content.length, 0) <= 100000,
    'Message context is invalid or too large.',
  );

const envelope = z.object({
  requestId: id,
  conversationId: id,
  assistantMessageId: id,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const conductorEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('started'), run: runInfoSchema.optional() }),
  z.strictObject({ type: z.literal('delta'), text: z.string().max(100000) }),
  z.strictObject({ type: z.literal('reset') }),
  z.strictObject({ type: z.literal('activity'), activity: activitySchema }),
  z.strictObject({ type: z.literal('artifact'), artifact: artifactReferenceSchema }),
  z.strictObject({
    type: z.literal('completed'),
    partial: z.boolean().optional(),
    run: runInfoSchema.optional(),
  }),
  z.strictObject({ type: z.literal('stopped') }),
  z.strictObject({
    type: z.literal('failed'),
    error: z.string().max(2000),
    interrupted: z.boolean(),
    run: runInfoSchema.optional(),
    settingsHelp: z.boolean().optional(),
  }),
]);

function parseEvent(input: unknown): ChatEvent {
  const raw = z.record(z.string(), z.unknown()).parse(input);
  const { requestId, conversationId, assistantMessageId, sequence, ...payload } = raw;
  return {
    ...envelope.parse({ requestId, conversationId, assistantMessageId, sequence }),
    ...conductorEventSchema.parse(payload),
  };
}

/** Decode across arbitrary byte/frame boundaries; comments are SSE heartbeats. */
export async function* readChatEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        if (frame.length > 250000) throw new Error('Chat stream frame is too large.');
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield parseEvent(JSON.parse(data));
      }
      if (buffer.length > 250000) throw new Error('Chat stream frame is too large.');
      if (done) {
        if (buffer.trim() && !buffer.trim().startsWith(':'))
          throw new Error('Incomplete chat stream frame.');
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
