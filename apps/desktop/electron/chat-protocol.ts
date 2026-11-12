import { z } from 'zod';
import type { ChatEvent } from '@aria/shared';

const id = z.string().min(1).max(200);
export const chatRequestSchema = z
  .object({
    requestId: id,
    conversationId: id,
    assistantMessageId: id,
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
const eventSchema = z.discriminatedUnion('type', [
  envelope.extend({ type: z.literal('started') }).strict(),
  envelope.extend({ type: z.literal('delta'), text: z.string().max(100000) }).strict(),
  envelope.extend({ type: z.literal('completed') }).strict(),
  envelope.extend({ type: z.literal('stopped') }).strict(),
  envelope
    .extend({ type: z.literal('failed'), error: z.string().max(2000), interrupted: z.boolean() })
    .strict(),
]);

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
        if (data) yield eventSchema.parse(JSON.parse(data));
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
