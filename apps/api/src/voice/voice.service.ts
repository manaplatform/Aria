import { Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { endpoint } from '../providers/providers.service';
import { ConfigurationError, ModelRegistry } from '../providers/model-registry.service';
import { Conductor } from '../conductor/conductor.service';
import type { ChatRequest, ConductorEvent } from '@aria/shared';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VoiceStartDto, VoiceControlDto } from './voice.dto';

@Injectable()
export class VoiceService implements OnApplicationBootstrap, OnModuleDestroy {
  private server = new WebSocketServer({ noServer: true, maxPayload: 512_000 });
  private peers = new Set<WebSocket>();
  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(ModelRegistry) private readonly registry: ModelRegistry,
    @Inject(Conductor) private readonly conductor: Conductor,
  ) {}
  onApplicationBootstrap() {
    this.host.httpAdapter
      .getHttpServer()
      .on(
        'upgrade',
        (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
          const expected = Buffer.from(`Bearer ${process.env.ARIA_INTERNAL_TOKEN || ''}`);
          const actual = Buffer.from(request.headers.authorization || '');
          if (
            request.url !== '/voice' ||
            !process.env.ARIA_INTERNAL_TOKEN ||
            actual.length !== expected.length ||
            !timingSafeEqual(actual, expected) ||
            this.peers.size
          ) {
            socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            return;
          }
          this.server.handleUpgrade(request, socket, head, (peer) => this.attach(peer));
        },
      );
  }
  private attach(peer: WebSocket) {
    this.peers.add(peer);
    let upstream: WebSocket | undefined;
    let starting = false;
    let ready = false;
    let closing = false;
    let closed = false;
    let bytes = 0;
    const abort = new AbortController();
    const seenDelegations = new Set<string>();
    const fragments: { text: string; end: number; role: 'user' | 'assistant' }[] = [];
    let fragmentCharacters = 0;
    let delegated = false;
    let lastOffset = -1;
    const startedAt = Date.now();
    const timeout = setTimeout(
      () =>
        fail('The voice session did not become ready. Check that the endpoint supports GPT-Live.'),
      15000,
    );
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const send = (event: object) => {
      if (peer.readyState === WebSocket.OPEN) {
        if (peer.bufferedAmount > 2_000_000) {
          peer.terminate();
          return;
        }
        peer.send(JSON.stringify(event));
      }
    };
    const fail = (
      error = 'The voice connection failed. Check GPT-Live availability, credentials, and your network.',
    ) => {
      if (closed) return;
      send({ type: 'failed', error });
      closed = true;
      cleanup();
      peer.close();
    };
    const cleanup = () => {
      abort.abort();
      clearTimeout(timeout);
      clearTimeout(closeTimer);
      upstream?.terminate();
      this.peers.delete(peer);
    };
    const end = () => {
      if (closing || closed) return;
      closing = true;
      abort.abort();
      if (!ready || upstream?.readyState !== WebSocket.OPEN) {
        fail('The voice session ended before it was ready.');
        return;
      }
      upstream.send(JSON.stringify({ type: 'session.close' }));
      closeTimer = setTimeout(
        () => fail('Voice finalization timed out. The session was closed.'),
        15000,
      );
    };
    peer.on('message', async (raw) => {
      try {
        const event = JSON.parse(raw.toString());
        if (event.type === 'start' && !starting) {
          const parsed = plainToInstance(VoiceStartDto, event);
          if (
            (await validate(parsed, { whitelist: true, forbidNonWhitelisted: true })).length ||
            parsed.messages.reduce((n, m) => n + m.content.length, 0) > 100000
          ) {
            fail('Invalid voice session request.');
            return;
          }
          starting = true;
          const configured = await this.registry.resolve(abort.signal, undefined, true);
          const profile = configured.config.live;
          const voiceModel = profile && configured.models.get(profile.model);
          if (
            !profile ||
            !voiceModel ||
            !voiceModel.capabilities.includes('live') ||
            (voiceModel.voices && !voiceModel.voices.includes(profile.voice))
          ) {
            fail('Select an available Live Voice profile in Settings → AI Models.');
            return;
          }
          if (closed || peer.readyState !== WebSocket.OPEN) return;
          const config = voiceModel.connection;
          const runDelegation = async (id: string, offset: number) => {
            const reply = (text: string) => {
              if (!closing && !closed && upstream?.readyState === WebSocket.OPEN)
                upstream.send(
                  JSON.stringify({
                    type: 'session.commentary.append',
                    event_id: randomUUID(),
                    delegation_id: id,
                    content: text.slice(0, 1500),
                  }),
                );
            };
            if (delegated) {
              reply('Another request is still running. Ask again when it finishes.');
              return;
            }
            delegated = true;
            try {
              // Transcript deltas can arrive just after the delegation marker.
              await new Promise<void>((resolve) => setTimeout(resolve, 250));
              if (abort.signal.aborted) return;
              const turns: ChatRequest['messages'] = [];
              for (const fragment of fragments
                .filter((item) => item.end <= offset)
                .sort((a, b) => a.end - b.end)) {
                const turn = turns.at(-1);
                if (turn?.role === fragment.role) turn.content += fragment.text;
                else turns.push({ role: fragment.role, content: fragment.text });
              }
              const latest = fragments.filter(
                (item) => item.role === 'user' && item.end > lastOffset && item.end <= offset,
              );
              if (
                !latest
                  .map((item) => item.text)
                  .join('')
                  .trim()
              ) {
                reply('I did not catch that request. Please repeat it.');
                return;
              }
              lastOffset = offset;
              while (turns.at(-1)?.role === 'assistant') turns.pop();
              const messages = [...parsed.messages, ...turns]
                .filter((turn) => turn.content.trim())
                .slice(-41);
              while (
                messages.length > 1 &&
                messages.reduce((n, turn) => n + turn.content.length, 0) > 100_000
              )
                messages.shift();
              const requestId = randomUUID();
              let terminal:
                Extract<ConductorEvent, { type: 'completed' | 'failed' | 'stopped' }> | undefined;
              const text = await this.conductor.run(
                {
                  requestId,
                  conversationId: parsed.conversationId,
                  assistantMessageId: parsed.assistantMessageId,
                  messages,
                },
                abort.signal,
                (event) => {
                  if (
                    event.type === 'completed' ||
                    event.type === 'failed' ||
                    event.type === 'stopped'
                  )
                    terminal = event;
                  send({ type: 'conductor', requestId, event });
                },
                configured.config,
              );
              if (terminal?.type === 'failed') reply(text.trim() || terminal.error);
              else if (terminal?.type === 'completed')
                reply(text.trim() || 'The result is available in the conversation.');
            } finally {
              delegated = false;
            }
          };
          const url = new URL(endpoint(config.baseUrl, 'live/sessions'));
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
          upstream = new WebSocket(url, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
            maxPayload: 2_000_000,
            handshakeTimeout: 15000,
          });
          upstream.on('open', () =>
            upstream?.send(
              JSON.stringify({
                type: 'session.start',
                session: {
                  model: voiceModel.id,
                  store: false,
                  instructions:
                    'You are Aria. Speak naturally and delegate user requests for information, reasoning, or action to the application. Report completed work only when the application confirms it.',
                  audio: {
                    format: { type: 'audio/pcm', rate: 24000 },
                    output: { voice: profile.voice },
                  },
                  input: (voiceModel.connection.id === configured.primary.connection.id
                    ? parsed.messages
                    : []
                  ).map((m) => ({
                    type: 'message',
                    role: m.role,
                    content: [
                      {
                        type: m.role === 'assistant' ? 'output_text' : 'input_text',
                        text: m.content,
                      },
                    ],
                  })),
                  delegation: { type: 'client' },
                },
              }),
            ),
          );
          upstream.on('message', (data) => {
            try {
              const item = JSON.parse(data.toString());
              if (item.type === 'session.started') {
                clearTimeout(timeout);
                ready = true;
                send({ type: 'ready' });
              } else if (
                item.type === 'session.output_audio.delta' &&
                typeof item.delta === 'string' &&
                item.delta.length <= 200000
              )
                send({ type: 'audio', audio: item.delta });
              else if (
                ['session.input_transcript.delta', 'session.output_transcript.delta'].includes(
                  item.type,
                ) &&
                typeof item.delta === 'string' &&
                item.delta.length <= 10000 &&
                Number.isFinite(item.start_ms) &&
                Number.isFinite(item.end_ms) &&
                item.start_ms >= 0 &&
                item.end_ms >= item.start_ms
              ) {
                const role = item.type === 'session.input_transcript.delta' ? 'user' : 'assistant';
                fragments.push({ role, text: item.delta, end: item.end_ms });
                fragmentCharacters += item.delta.length;
                while (fragmentCharacters > 40_000 || fragments.length > 1500)
                  fragmentCharacters -= fragments.shift()!.text.length;
                send({
                  type: 'transcript',
                  role,
                  text: item.delta,
                  startMs: item.start_ms,
                  endMs: item.end_ms,
                });
              } else if (
                ready &&
                !closing &&
                item.type === 'session.delegation.created' &&
                item.delegation?.target === 'client' &&
                typeof item.delegation.id === 'string' &&
                item.delegation.id.length <= 200 &&
                Number.isFinite(item.offset_ms) &&
                item.offset_ms >= 0
              ) {
                if (seenDelegations.has(item.delegation.id)) return;
                if (seenDelegations.size >= 250) {
                  fail('The voice session reached its delegation limit.');
                  return;
                }
                seenDelegations.add(item.delegation.id);
                void runDelegation(item.delegation.id, item.offset_ms).catch(() => fail());
              } else if (item.type === 'session.closed') {
                if (!closing) {
                  fail('The provider ended the voice session. Start a new session to continue.');
                  return;
                }
                closed = true;
                send({ type: 'ended' });
                cleanup();
                peer.close();
              } else if (
                item.type === 'error' ||
                (item.type === 'response.event' && item.event?.type === 'response.failed')
              )
                fail(
                  'GPT-Live rejected the session or its delegated model. Check the selected models and endpoint.',
                );
            } catch {
              fail();
            }
          });
          upstream.on('error', () => fail());
          upstream.on('close', () => {
            if (!closed) fail('The voice connection ended before finalization.');
          });
        } else if (
          (
            await validate(plainToInstance(VoiceControlDto, event), {
              whitelist: true,
              forbidNonWhitelisted: true,
            })
          ).length
        )
          fail('Invalid voice control.');
        else if (event.type === 'end') end();
        else if (ready && !closing && upstream?.readyState === WebSocket.OPEN) {
          if (
            event.type === 'audio' &&
            typeof event.audio === 'string' &&
            /^[A-Za-z0-9+/]*={0,2}$/.test(event.audio) &&
            event.audio.length <= 64000
          ) {
            const length = Buffer.byteLength(event.audio, 'base64');
            bytes += length;
            if (length % 2 || bytes > (Date.now() - startedAt + 3000) * 48) {
              fail('Voice audio arrived too quickly.');
              return;
            }
            if (upstream.bufferedAmount > 1_000_000) {
              fail('Voice connection could not keep up.');
              return;
            }
            upstream.send(
              JSON.stringify({ type: 'session.input_audio.append', audio: event.audio }),
            );
          } else if (event.type === 'mute' && typeof event.muted === 'boolean')
            upstream.send(
              JSON.stringify({
                type: event.muted ? 'session.input_audio.mute' : 'session.input_audio.unmute',
              }),
            );
          else fail('Invalid voice control.');
        } else fail('Wait for the voice session to become ready.');
      } catch (error) {
        fail(error instanceof ConfigurationError ? error.message : undefined);
      }
    });
    peer.on('error', () => fail());
    peer.on('close', () => {
      closed = true;
      cleanup();
    });
  }
  onModuleDestroy() {
    for (const peer of this.peers) peer.terminate();
    this.server.close();
  }
}
