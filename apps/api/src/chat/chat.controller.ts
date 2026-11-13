import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { artifactReferenceSchema, identifier } from '@aria/shared';
import { Conductor } from '../conductor/conductor.service';
import { RunAssets, RunError } from '../conductor/run-assets';
import { ModelRegistry } from '../providers/model-registry.service';
import { ChatRequestDto, AttachmentMetadataDto } from './chat.dto';
import { LocalApiGuard } from './local-api.guard';

@Controller('chat')
@UseGuards(LocalApiGuard)
export class ChatController {
  constructor(
    @Inject(ModelRegistry) private readonly registry: ModelRegistry,
    @Inject(Conductor) private readonly conductor: Conductor,
    @Inject(RunAssets) private readonly assets: RunAssets,
  ) {}

  @Get('capabilities')
  capabilities() {
    return this.registry.status();
  }

  @Post(':requestId/attachments')
  @UseInterceptors(
    FilesInterceptor('files', 4, {
      limits: { fileSize: 25_000_000, files: 4, fields: 1, fieldSize: 4096 },
    }),
  )
  stage(
    @Param('requestId') requestId: string,
    @Body() input: AttachmentMetadataDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    try {
      identifier.parse(requestId);
      const metadata: unknown = JSON.parse(input.metadata);
      if (!Array.isArray(metadata) || metadata.length !== files.length) throw new Error();
      this.assets.stage(
        requestId,
        files.map((file, index) => {
          const item = artifactReferenceSchema.parse(metadata[index]);
          if (item.size !== file.size || item.mimeType !== file.mimetype) throw new Error();
          return { ...item, bytes: file.buffer };
        }),
      );
      return { staged: true };
    } catch (error) {
      throw new BadRequestException(
        error instanceof RunError ? error.message : 'Invalid attachment metadata.',
      );
    }
  }

  @Get(':requestId/artifacts/:artifactId')
  artifact(
    @Param('requestId') requestId: string,
    @Param('artifactId') artifactId: string,
    @Res() response: Response,
  ) {
    const artifact = this.assets.get(requestId, artifactId);
    if (!artifact) throw new NotFoundException('This artifact is no longer available.');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', artifact.mimeType);
    response.send(artifact.bytes);
  }

  @Delete(':requestId/assets')
  release(@Param('requestId') requestId: string) {
    this.assets.release(requestId);
    return { released: true };
  }

  @Post('stream')
  async stream(@Body() input: ChatRequestDto, @Req() request: Request, @Res() response: Response) {
    if (
      input.messages.at(-1)?.role !== 'user' ||
      input.messages.some((message) => !message.content.trim()) ||
      input.messages.reduce((sum, message) => sum + message.content.length, 0) > 100_000
    )
      throw new BadRequestException(
        'Provide a user message and at most 100,000 characters of context.',
      );
    const controller = new AbortController();
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
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(': heartbeat\n\n');
    }, 15000);
    try {
      await this.conductor.run(input, controller.signal, (event) => {
        if (!response.destroyed && !response.writableEnded)
          response.write(
            `data: ${JSON.stringify({
              requestId: input.requestId,
              conversationId: input.conversationId,
              assistantMessageId: input.assistantMessageId,
              sequence: ++sequence,
              ...event,
            })}\n\n`,
          );
      });
    } finally {
      clearInterval(heartbeat);
      controller.abort();
      request.off('aborted', disconnect);
      response.off('close', disconnect);
      response.end();
    }
  }
}
