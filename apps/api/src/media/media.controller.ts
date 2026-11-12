import type {} from 'multer';
import {
  Body,
  Controller,
  Inject,
  Post,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { LocalApiGuard } from '../chat/local-api.guard';
import { MediaService } from './media.service';
export class MediaDto {
  @IsIn(['image', 'speech', 'transcription']) mode!: 'image' | 'speech' | 'transcription';
  @IsString() @MinLength(1) @MaxLength(200) model!: string;
  @IsString() @MaxLength(32000) prompt!: string;
  @IsOptional()
  @IsIn([
    'marin',
    'cedar',
    'alloy',
    'ash',
    'ballad',
    'coral',
    'echo',
    'fable',
    'nova',
    'onyx',
    'sage',
    'shimmer',
    'verse',
  ])
  voice?: string;
}
@Controller('media')
@UseGuards(LocalApiGuard)
export class MediaController {
  constructor(@Inject(MediaService) private readonly media: MediaService) {}
  @Post('generate')
  @UseInterceptors(
    FilesInterceptor('files', 4, {
      limits: { fileSize: 25_000_000, files: 4, fields: 4, fieldSize: 100000 },
    }),
  )
  async generate(
    @Body() input: MediaDto,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 300000);
    const close = () => {
      if (!response.writableEnded) abort.abort();
    };
    request.on('aborted', close);
    response.on('close', close);
    try {
      const result = await this.media.generate(input, files || [], abort.signal);
      if ('text' in result) response.json(result);
      else {
        response.setHeader('Content-Type', result.mime);
        response.setHeader('Cache-Control', 'no-store');
        response.send(result.bytes);
      }
    } finally {
      clearTimeout(timer);
      request.off('aborted', close);
      response.off('close', close);
    }
  }
}
