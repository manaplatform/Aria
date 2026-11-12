import type { ChatEvent, LiveEvent, LiveRequest, MediaRequest } from '@aria/shared';
import { z } from 'zod';
import WebSocket from 'ws';
import { ChatService } from './chat-service';
import { MediaStorage, pcmWav } from './media-storage';
const id = z.string().min(1).max(200);
export const mediaRequestSchema = z
  .object({
    requestId: id,
    conversationId: id,
    assistantMessageId: id,
    mode: z.enum(['image', 'speech', 'transcription']),
    model: id,
    prompt: z.string().max(32000),
    voice: z.string().max(200).optional(),
    assetIds: z.array(z.string().uuid()).max(4),
  })
  .strict();
export const liveRequestSchema = z
  .object({
    sessionId: id,
    conversationId: id,
    model: id,
    chatModel: id,
    voice: z.string().max(200),
    messages: z
      .array(
        z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(100000) }).strict(),
      )
      .max(41),
  })
  .strict()
  .refine((r) => r.messages.reduce((n, m) => n + m.content.length, 0) <= 100000);
export class MediaService {
  private requests = new Map<
    string,
    { controller: AbortController; conversationId: string; done: Promise<void>; stopped: boolean }
  >();
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
    private readonly emit: (event: ChatEvent) => void,
    private readonly emitLive: (event: LiveEvent) => void,
  ) {}
  assertIdle() {
    if (this.requests.size || this.live)
      throw new Error('Stop active media and voice sessions before changing the connection.');
  }
  assertConversationIdle(conversationId: string) {
    if (this.live || [...this.requests.values()].some((r) => r.conversationId === conversationId))
      throw new Error('This conversation already has an operation in progress.');
  }
  submit(input: MediaRequest) {
    const request = mediaRequestSchema.parse(input);
    this.assertConversationIdle(request.conversationId);
    if (this.requests.has(request.requestId)) throw new Error('This request is already running.');
    const active = {
      controller: new AbortController(),
      conversationId: request.conversationId,
      done: Promise.resolve(),
      stopped: false,
    };
    this.requests.set(request.requestId, active);
    let sequence = 0;
    const send = (event: object) =>
      this.emit({
        requestId: request.requestId,
        conversationId: request.conversationId,
        assistantMessageId: request.assistantMessageId,
        sequence: ++sequence,
        ...event,
      } as ChatEvent);
    active.done = (async () => {
      const timer = setTimeout(() => active.controller.abort(), 310000);
      try {
        send({ type: 'started' });
        const form = new FormData();
        form.set('mode', request.mode);
        form.set('model', request.model);
        form.set('prompt', request.prompt);
        if (request.voice) form.set('voice', request.voice);
        for (const assetId of request.assetIds) {
          const { asset, bytes } = await this.storage.get(assetId);
          form.append(
            'files',
            new Blob([new Uint8Array(bytes)], { type: asset.mimeType }),
            asset.name,
          );
        }
        const response = await this.chat.http('media/generate', {
          method: 'POST',
          body: form,
          signal: active.controller.signal,
        });
        if (request.mode === 'transcription') {
          const value = await response.json();
          const text = z.string().min(1).max(100000).parse(value.text);
          if (active.stopped) return;
          send({ type: 'delta', text });
          send({ type: 'completed' });
        } else {
          if (!response.body) throw new Error('The provider returned no media.');
          const reader = response.body.getReader();
          const chunks: Buffer[] = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > 64_000_000) throw new Error('Generated media exceeds the 64 MB limit.');
              chunks.push(Buffer.from(value));
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
          if (active.stopped) return;
          const asset = await this.storage.put(
            Buffer.concat(chunks),
            request.mode === 'image' ? 'aria-image.png' : 'aria-speech.wav',
            request.mode === 'image' ? 'image/png' : 'audio/wav',
          );
          if (!active.stopped) send({ type: 'completed', assets: [asset] });
        }
      } catch (error) {
        if (!active.stopped)
          send({
            type: 'failed',
            error:
              error instanceof Error ? error.message.slice(0, 2000) : 'Media generation failed.',
            interrupted: active.controller.signal.aborted,
          });
      } finally {
        if (active.stopped) send({ type: 'stopped' });
        clearTimeout(timer);
        active.controller.abort();
        this.requests.delete(request.requestId);
      }
    })();
  }
  async cancel(id: string) {
    const request = this.requests.get(id);
    if (request) {
      request.stopped = true;
      request.controller.abort();
      await request.done;
    }
  }
  async close() {
    await Promise.all([...this.requests.keys()].map((id) => this.cancel(id)));
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
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        void finish('The voice session timed out during startup.');
      }, 20000);
      const finish = async (error?: string) => {
        if (live.finishing) return;
        live.finishing = true;
        clearTimeout(timeout);
        ws.terminate();
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
            model: request.model,
            chatModel: request.chatModel,
            voice: request.voice,
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
