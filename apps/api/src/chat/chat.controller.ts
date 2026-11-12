import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ChatEvent } from '@aria/shared';
import { AiService, providerError } from '../ai/ai.service';
import { ChatRequestDto } from './chat.dto';
import { LocalApiGuard } from './local-api.guard';

@Controller('chat')
@UseGuards(LocalApiGuard)
export class ChatController {
  constructor(@Inject(AiService) private readonly ai: AiService) {}

  @Get('capabilities')
  capabilities() {
    return this.ai.capabilities();
  }

  @Post('stream')
  async stream(
    @Body() input: ChatRequestDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (
      input.messages.at(-1)?.role !== 'user' ||
      input.messages.some((message) => !message.content.trim()) ||
      input.messages.reduce((sum, message) => sum + message.content.length, 0) > 100000
    )
      throw new BadRequestException(
        'Provide a user message and at most 100,000 characters of context.',
      );
    if (!this.ai.capabilities().configured)
      throw new ServiceUnavailableException(
        'Configure an API key and model in Settings to start chatting.',
      );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const disconnect = () => {
      if (!response.writableEnded) controller.abort();
    };
    request.on('aborted', disconnect);
    response.on('close', disconnect);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    let sequence = 0;
    const send = (
      payload:
        | Omit<Extract<ChatEvent, { type: 'delta' }>, keyof ChatRequestDto | 'sequence'>
        | { type: 'started' | 'completed' }
        | { type: 'failed'; error: string; interrupted: boolean },
    ) => {
      if (response.destroyed || response.writableEnded) return;
      const event = {
        requestId: input.requestId,
        conversationId: input.conversationId,
        assistantMessageId: input.assistantMessageId,
        sequence: ++sequence,
        ...payload,
      };
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(': heartbeat\n\n');
    }, 15000);
    try {
      send({ type: 'started' });
      const result = this.ai.generate(input.messages, controller.signal);
      let failed = false;
      let hasText = false;
      for await (const part of result.stream) {
        if (controller.signal.aborted) break;
        if (part.type === 'text-delta') {
          hasText ||= Boolean(part.text);
          send({ type: 'delta', text: part.text });
        }
        if (part.type === 'error') {
          failed = true;
          send({ type: 'failed', error: providerError(part.error), interrupted: false });
          break;
        }
      }
      if (!failed) {
        if (controller.signal.aborted)
          send({
            type: 'failed',
            error: 'The response was interrupted. Please retry.',
            interrupted: true,
          });
        else if (!hasText)
          send({
            type: 'failed',
            error:
              'The provider returned no text. Check that your selected model supports text chat, then retry.',
            interrupted: false,
          });
        else send({ type: 'completed' });
      }
    } catch (error) {
      send({ type: 'failed', error: providerError(error), interrupted: controller.signal.aborted });
    } finally {
      controller.abort();
      clearTimeout(timeout);
      clearInterval(heartbeat);
      request.removeListener('aborted', disconnect);
      response.removeListener('close', disconnect);
      response.end();
    }
  }
}
