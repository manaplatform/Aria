import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsString, MaxLength } from 'class-validator';
import { LocalApiGuard } from '../chat/local-api.guard';
import { ProvidersService } from './providers.service';

export class ConnectionDto {
  @IsIn(['openai']) provider!: 'openai';
  @IsString() @MaxLength(2000) baseUrl!: string;
  @IsString() @MaxLength(16000) apiKey!: string;
}
@Controller('providers')
@UseGuards(LocalApiGuard)
export class ProvidersController {
  constructor(@Inject(ProvidersService) private readonly providers: ProvidersService) {}
  @Post('models') list(@Body() input: ConnectionDto) {
    return this.providers.list(input, true);
  }
}
