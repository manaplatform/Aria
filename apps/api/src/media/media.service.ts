import type {} from 'multer';
import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import WebSocket from 'ws';
import { endpoint, readBounded } from '../providers/providers.service';
import type { ResolvedModel } from '../providers/model-registry.service';
import { providerError } from '../ai/ai.service';

export function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export function realtimeSpeech(
  model: string,
  text: string,
  voice: string,
  signal: AbortSignal,
  config: ResolvedModel['connection'],
): Promise<Buffer> {
  const url = new URL(endpoint(config.baseUrl, 'realtime'));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('model', model);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      maxPayload: 2_000_000,
      handshakeTimeout: 15000,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      ws.close();
      if (error || !size) reject(error || new Error('No speech returned.'));
      else resolve(wav(Buffer.concat(chunks)));
    };
    const abort = () => {
      finish(new Error('Speech generation stopped.'));
      ws.terminate();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            output_modalities: ['audio'],
            audio: { output: { format: { type: 'audio/pcm', rate: 24000 }, voice } },
          },
        }),
      ),
    );
    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        if (event.type === 'session.updated')
          ws.send(
            JSON.stringify({
              type: 'response.create',
              response: {
                conversation: 'none',
                input: [],
                output_modalities: ['audio'],
                instructions: `Read the following text verbatim, without adding anything:\n${text}`,
              },
            }),
          );
        if (event.type === 'response.output_audio.delta') {
          const chunk = Buffer.from(event.delta, 'base64');
          size += chunk.length;
          if (size > 64_000_000) throw new Error('Audio too large.');
          chunks.push(chunk);
        }
        if (
          event.type === 'error' ||
          (event.type === 'response.done' && event.response?.status !== 'completed')
        )
          throw new Error('Speech API rejected the request.');
        if (event.type === 'response.done') finish();
      } catch (error) {
        finish(error);
      }
    });
    ws.on('error', (error) => finish(error));
    ws.on('close', () => finish(new Error('Speech connection closed before completion.')));
  });
}
@Injectable()
export class MediaService {
  async generate(
    input: {
      mode: 'image' | 'speech' | 'transcription';
      target: ResolvedModel;
      prompt: string;
      voice?: string;
    },
    files: Express.Multer.File[],
    signal: AbortSignal,
  ): Promise<{ bytes: Buffer; mime: string } | { text: string }> {
    const { target } = input;
    const config = target.connection;
    const model = target.id;
    const voice = input.voice || target.voices?.[0] || 'alloy';
    if (input.mode === 'speech' && target.voices && !target.voices.includes(voice))
      throw new BadRequestException('This model does not support the selected voice.');
    if (
      input.mode === 'speech' &&
      (!input.prompt.trim() || input.prompt.length > 4096 || files.length)
    )
      throw new BadRequestException('Speech accepts up to 4,096 characters and no files.');
    if (
      input.mode === 'image' &&
      (!input.prompt.trim() ||
        input.prompt.length > 32000 ||
        files.length > 4 ||
        files.some(
          (f) =>
            !['image/png', 'image/jpeg', 'image/webp'].includes(f.mimetype) || f.size > 20_000_000,
        ))
    )
      throw new BadRequestException(
        'Use a prompt and up to four PNG, JPEG, or WebP images, at most 20 MB each.',
      );
    if (
      input.mode === 'transcription' &&
      (files.length !== 1 ||
        files[0].size > 25_000_000 ||
        ![
          'audio/flac',
          'audio/mpeg',
          'audio/mp4',
          'video/mp4',
          'audio/ogg',
          'audio/wav',
          'audio/webm',
          'video/webm',
        ].includes(files[0].mimetype))
    )
      throw new BadRequestException('Choose one supported audio file up to 25 MB.');
    if (
      input.mode === 'image' &&
      files.some((file) => {
        const hex = file.buffer.subarray(0, 12).toString('hex');
        return file.mimetype === 'image/png'
          ? !hex.startsWith('89504e470d0a1a0a')
          : file.mimetype === 'image/jpeg'
            ? !hex.startsWith('ffd8ff')
            : file.buffer.toString('ascii', 0, 4) !== 'RIFF' ||
              file.buffer.toString('ascii', 8, 12) !== 'WEBP';
      })
    )
      throw new BadRequestException('An uploaded image does not match its declared file type.');
    try {
      if (input.mode === 'speech' && target.transport === 'realtime')
        return {
          bytes: await realtimeSpeech(model, input.prompt, voice, signal, config),
          mime: 'audio/wav',
        };
      let route: string;
      let body: string | FormData;
      let contentType: string | undefined;
      if (input.mode === 'transcription' || (input.mode === 'image' && files.length)) {
        route = input.mode === 'image' ? 'images/edits' : 'audio/transcriptions';
        const form = new FormData();
        form.set('model', model);
        if (input.mode === 'image') {
          form.set('prompt', input.prompt);
          form.set('n', '1');
          if (target.transport === 'inline-png') form.set('output_format', 'png');
          else form.set('response_format', 'b64_json');
        }
        files.forEach((f) =>
          form.append(
            input.mode === 'image' ? 'image[]' : 'file',
            new Blob([new Uint8Array(f.buffer)], { type: f.mimetype }),
            f.originalname,
          ),
        );
        body = form;
      } else {
        contentType = 'application/json';
        if (input.mode === 'image') {
          route = 'images/generations';
          body = JSON.stringify({
            model: model,
            prompt: input.prompt,
            n: 1,
            ...(target.transport === 'inline-png'
              ? { output_format: 'png' }
              : { response_format: 'b64_json' }),
          });
        } else {
          route = 'audio/speech';
          body = JSON.stringify({
            model: model,
            input: input.prompt,
            voice: voice,
            response_format: 'wav',
          });
        }
      }
      const response = await fetch(endpoint(config.baseUrl, route), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          ...(contentType ? { 'Content-Type': contentType } : {}),
        },
        body,
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw { statusCode: response.status };
      }
      const bytes = await readBounded(response, 90_000_000);
      if (input.mode === 'speech') {
        if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
          throw new Error('Expected WAV audio.');
        return { bytes, mime: 'audio/wav' };
      }
      const result = JSON.parse(bytes.toString());
      if (input.mode === 'transcription') {
        if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 100000)
          throw new Error('Invalid transcript.');
        return { text: result.text };
      }
      const image = result.data?.[0]?.b64_json;
      if (typeof image !== 'string' || image.length > 86_000_000)
        throw new Error('Expected an inline PNG image.');
      const png = Buffer.from(image, 'base64');
      if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
        throw new Error('Expected a PNG image.');
      return { bytes: png, mime: 'image/png' };
    } catch (error) {
      throw new BadGatewayException(providerError(error));
    }
  }
}
