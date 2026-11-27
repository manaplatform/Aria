import {
  BadRequestException,
  Body,
  ConflictException,
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
import { artifactReferenceSchema, identifier, loopCommandSchema, managedExecutionSchema, userPersonalizationSchema } from '@aria/shared';
import { Conductor } from '../conductor/conductor.service';
import { ToolRegistry } from '../conductor/tool-registry';
import { WebService } from '../web/web.service';
import { RunAssets, RunError } from '../conductor/run-assets';
import { ModelRegistry } from '../providers/model-registry.service';
import { ChatRequestDto, AttachmentMetadataDto } from './chat.dto';
import { LocalApiGuard } from './local-api.guard';
import { ChatStream } from './chat-stream';

@Controller('chat')
@UseGuards(LocalApiGuard)
export class ChatController {
  constructor(
    @Inject(ModelRegistry) private readonly registry: ModelRegistry,
    @Inject(Conductor) private readonly conductor: Conductor,
    @Inject(RunAssets) private readonly assets: RunAssets,
    @Inject(ToolRegistry) private readonly tools: ToolRegistry,
    @Inject(WebService) private readonly web: WebService,
  ) {}

  @Get('capabilities')
  capabilities() {
    return this.registry.status();
  }

  @Get('tools')
  async toolSettings() {
    const registry = await this.registry
      .resolve(AbortSignal.timeout(10_000))
      .catch(() => undefined);
    const web = this.web.scope({ requestId: '', conversationId: '', messages: [] }, true);
    return this.tools.settings(registry, web.native);
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
    if (input.personalization?.persona && (process.env.ARIA_MANAGED !== '1' ||
        !userPersonalizationSchema.safeParse({ ...input.personalization }).success))
      throw new BadRequestException('Invalid Persona settings.');
    if (input.execution && (process.env.ARIA_MANAGED !== '1' || !managedExecutionSchema.safeParse(input.execution).success))
      throw new BadRequestException('Invalid managed execution identity.');
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
    const stream = new ChatStream(response, controller, input);
    const heartbeat = setInterval(() => stream.heartbeat(), 15_000);
    try {
      await this.conductor.run(input, controller.signal, stream.push);
      await stream.drain();
    } finally {
      clearInterval(heartbeat);
      controller.abort();
      request.off('aborted', disconnect);
      response.off('close', disconnect);
      response.end();
    }
  }

  @Post(':requestId/control')
  control(@Param('requestId') id: string, @Body() value: unknown) {
    const parsed = loopCommandSchema.safeParse(value);
    if (process.env.ARIA_MANAGED !== '1' || !parsed.success || parsed.data.requestId !== id)
      throw new BadRequestException('Invalid execution control.');
    try {
      const result = this.conductor.control(parsed.data);
      if (result) return { accepted: true, applied: result === 'applied' };
    } catch (error) {
      throw new ConflictException(error instanceof RunError ? error.message : 'The command could not be applied.');
    }
    throw new ConflictException('The execution is no longer active.');
  }
}
