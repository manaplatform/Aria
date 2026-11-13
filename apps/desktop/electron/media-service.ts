import type { LiveEvent, LiveRequest } from '@aria/shared';
import { conductorEventSchema } from './chat-protocol';
import { z } from 'zod';
import WebSocket from 'ws';
import { ChatService } from './chat-service';
import { MediaStorage, pcmWav } from './media-storage';
const id = z.string().min(1).max(200);
export const liveRequestSchema = z
  .object({
    sessionId: id,
    conversationId: id,
    assistantMessageId: id,
    messages: z
      .array(
        z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(100000) }).strict(),
      )
      .max(41),
  })
  .strict()
  .refine((r) => r.messages.reduce((n, m) => n + m.content.length, 0) <= 100000);
export class MediaService {
  private live?: {
    request: LiveRequest;
    ws: WebSocket;
    ready: boolean;
    chunks: Buffer[];
    size: number;
    ending?: Promise<void>;
    resolveEnd: () => void;
    finishing: boolean;
  };
  constructor(
    private readonly chat: ChatService,
    private readonly storage: MediaStorage,
    private readonly emitLive: (event: LiveEvent) => void,
  ) {}
  assertIdle() {
    if (this.live) throw new Error('End Live Voice before continuing.');
  }

  async close() {
    await this.endLive();
  }

  async startLive(input: LiveRequest): Promise<void> {
    this.assertIdle();
    const request = liveRequestSchema.parse(input);
    const ws = this.chat.voiceSocket();
    let resolveEnd!: () => void;
    const ending = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });
    const live = {
      request,
      ws,
      ready: false,
      chunks: [] as Buffer[],
      size: 0,
      ending,
      resolveEnd,
      finishing: false,
    };
    this.live = live;
    const envelope = { sessionId: request.sessionId, conversationId: request.conversationId };
    let transcriptSize = 0;
    let transcriptFragments = 0;
    const transfer = new AbortController();
    let conductorEvents = Promise.resolve();
    const artifacts = new Map<string, string>();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        void finish('The voice session timed out during startup.');
      }, 20000);
      const finish = async (error?: string) => {
        if (live.finishing) return;
        live.finishing = true;
        clearTimeout(timeout);
        transfer.abort();
        ws.terminate();
        await conductorEvents.catch(() => undefined);
        let asset;
        try {
          if (live.size)
            asset = await this.storage.put(
              pcmWav(Buffer.concat(live.chunks)),
              'aria-live-replies.wav',
              'audio/wav',
            );
        } catch {
          error = 'Voice ended, but its audio replies could not be saved.';
        }
        this.emitLive({
          ...envelope,
          ...(error ? { type: 'failed', error, asset } : { type: 'ended', asset }),
        });
        if (this.live === live) this.live = undefined;
        live.resolveEnd();
        if (!settled) {
          settled = true;
          reject(new Error(error || 'Voice ended before startup.'));
        }
      };
      ws.on('open', () =>
        ws.send(
          JSON.stringify({
            type: 'start',
            sessionId: request.sessionId,
            conversationId: request.conversationId,
            assistantMessageId: request.assistantMessageId,
            messages: request.messages,
          }),
        ),
      );
      ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          if (live.finishing) return;
          if (event.type === 'ready') {
            live.ready = true;
            clearTimeout(timeout);
            this.emitLive({ ...envelope, type: 'ready' });
            if (!settled) {
              settled = true;
              resolve();
            }
          } else if (event.type === 'audio') {
            const audio = z
              .string()
              .max(200000)
              .regex(/^[A-Za-z0-9+/]*={0,2}$/)
              .parse(event.audio);
            const bytes = Buffer.from(audio, 'base64');
            live.size += bytes.length;
            if (live.size > 63_000_000 || bytes.length % 2)
              throw new Error('Audio exceeded its supported limit.');
            live.chunks.push(bytes);
            this.emitLive({ ...envelope, type: 'audio', audio });
          } else if (event.type === 'transcript') {
            const transcript = z
              .object({
                role: z.enum(['user', 'assistant']),
                text: z.string().max(10000),
                startMs: z.number().nonnegative(),
                endMs: z.number().nonnegative(),
              })
              .parse(event);
            transcriptSize += transcript.text.length;
            if (++transcriptFragments > 20000 || transcriptSize > 100000)
              throw new Error('Transcript limit exceeded.');
            this.emitLive({ ...envelope, type: 'transcript', ...transcript });
          } else if (event.type === 'conductor') {
            const requestId = z.string().uuid().parse(event.requestId);
            const parsed = conductorEventSchema.parse(event.event);
            conductorEvents = conductorEvents.then(async () => {
              if (transfer.signal.aborted) return;
              if (parsed.type === 'artifact') {
                try {
                  const asset = await this.chat.importArtifact(
                    requestId,
                    parsed.artifact,
                    transfer.signal,
                  );
                  artifacts.set(parsed.artifact.id, asset.id);
                  this.emitLive({
                    ...envelope,
                    type: 'conductor',
                    requestId,
                    event: { type: 'asset', asset },
                  });
                } catch {
                  this.emitLive({
                    ...envelope,
                    type: 'conductor',
                    requestId,
                    event: {
                      type: 'failed',
                      interrupted: false,
                      error: 'The voice result could not be saved.',
                    },
                  });
                }
              } else {
                if (parsed.type === 'activity' && parsed.activity.resultId) {
                  const id = parsed.activity.resultId;
                  parsed.activity.resultId = artifacts.get(id);
                  artifacts.delete(id);
                }
                this.emitLive({ ...envelope, type: 'conductor', requestId, event: parsed });
                if (
                  parsed.type === 'completed' ||
                  parsed.type === 'failed' ||
                  parsed.type === 'stopped'
                )
                  void this.chat.releaseAssets(requestId);
              }
            });
          } else if (event.type === 'ended') void finish();
          else if (event.type === 'failed') void finish(z.string().max(2000).parse(event.error));
          else throw new Error('Invalid voice event.');
        } catch {
          void finish('The voice stream was invalid or exceeded its supported limit.');
        }
      });
      ws.on('error', () => {
        void finish('The voice service could not connect. Check the endpoint and selected models.');
      });
      ws.on('close', () => {
        if (!live.finishing) void finish('The voice connection was interrupted.');
      });
    });
  }
  sendAudio(sessionId: string, audio: Uint8Array) {
    const live = this.live;
    if (!live?.ready || live.finishing || sessionId !== live.request.sessionId) return;
    if (!(audio instanceof Uint8Array) || audio.length > 24000 || audio.length % 2)
      throw new Error('Invalid microphone audio.');
    if (live.ws.bufferedAmount > 1_000_000) {
      live.ws.terminate();
      return;
    }
    live.ws.send(JSON.stringify({ type: 'audio', audio: Buffer.from(audio).toString('base64') }));
  }
  mute(sessionId: string, muted: boolean) {
    if (this.live?.ready && sessionId === this.live.request.sessionId)
      this.live.ws.send(JSON.stringify({ type: 'mute', muted }));
  }
  async endLive() {
    const live = this.live;
    if (!live || live.finishing) {
      await live?.ending;
      return;
    }
    if (live.ready && live.ws.readyState === WebSocket.OPEN)
      live.ws.send(JSON.stringify({ type: 'end' }));
    else live.ws.terminate();
    const timer = setTimeout(() => live.ws.terminate(), 17000);
    try {
      await live.ending;
    } finally {
      clearTimeout(timer);
    }
  }
}
