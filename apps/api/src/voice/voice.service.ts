import { Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { connection, endpoint, ProvidersService } from '../providers/providers.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VoiceStartDto, VoiceControlDto } from './voice.dto';
import { DEFAULT_SYSTEM_PROMPT } from '../ai/ai.service';

@Injectable()
export class VoiceService implements OnApplicationBootstrap, OnModuleDestroy {
  private server = new WebSocketServer({ noServer: true, maxPayload: 200000 });
  private peers = new Set<WebSocket>();
  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(ProvidersService) private readonly providers: ProvidersService,
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
      clearTimeout(timeout);
      clearTimeout(closeTimer);
      upstream?.terminate();
      this.peers.delete(peer);
    };
    const end = () => {
      if (closing || closed) return;
      closing = true;
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
          await this.providers.assertModel(event.model, undefined, 'live');
          await this.providers.assertModel(event.chatModel, undefined, 'chat');
          if (closed || peer.readyState !== WebSocket.OPEN) return;
          const config = connection();
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
                  model: event.model,
                  store: false,
                  instructions:
                    process.env.ARIA_SYSTEM_PROMPT ||
                    'You are Aria. Speak clearly and naturally. Delegate questions requiring reasoning to your backend.',
                  audio: {
                    format: { type: 'audio/pcm', rate: 24000 },
                    output: { voice: event.voice },
                  },
                  input: parsed.messages.map((m) => ({
                    type: 'message',
                    role: m.role,
                    content: [
                      {
                        type: m.role === 'assistant' ? 'output_text' : 'input_text',
                        text: m.content,
                      },
                    ],
                  })),
                  delegation: {
                    type: 'responses',
                    responses: {
                      model: event.chatModel,
                      instructions: process.env.ARIA_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
                      tool_choice: 'none',
                      max_output_tokens: 4096,
                    },
                  },
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
              )
                send({
                  type: 'transcript',
                  role: item.type.includes('input_') ? 'user' : 'assistant',
                  text: item.delta,
                  startMs: item.start_ms,
                  endMs: item.end_ms,
                });
              else if (item.type === 'session.closed') {
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
      } catch {
        fail();
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
