import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  NotFoundException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { proactiveRequestSchema, proactiveRunEnvelope } from '@aria/shared';
import type { Request, Response } from 'express';
import { ChatStream } from '../chat/chat-stream';
import { LocalApiGuard } from '../chat/local-api.guard';
import { Conductor } from './conductor.service';

@Controller('internal/proactive')
@UseGuards(LocalApiGuard)
export class ProactiveController {
  constructor(@Inject(Conductor) private readonly conductor: Conductor) {}

  @Post('stream')
  async stream(@Body() value: unknown, @Req() request: Request, @Res() response: Response) {
    if (process.env.ARIA_MANAGED !== '1') throw new NotFoundException();
    const parsed = proactiveRequestSchema.safeParse(value);
    if (!parsed.success) throw new BadRequestException('Invalid background execution.');
    const run = parsed.data;
    const envelope = proactiveRunEnvelope(run);
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    request.once('aborted', disconnect);
    response.once('close', disconnect);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    const stream = new ChatStream(response, controller, envelope);
    const heartbeat = setInterval(() => stream.heartbeat(), 15_000);
    try {
      await this.conductor.run(envelope, controller.signal, stream.push, undefined, undefined, run);
      await stream.drain();
    } finally {
      clearInterval(heartbeat);
      controller.abort();
      request.off('aborted', disconnect);
      response.off('close', disconnect);
      response.end();
    }
  }
}
