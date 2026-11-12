import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { jsonSchema, tool } from 'ai';
import { providerEndpointSchema } from '@aria/shared';
import { AiService, providerError } from '../ai/ai.service';
import { LocalApiGuard } from '../chat/local-api.guard';
import { ProvidersService } from './providers.service';

export class ConnectionDto {
  @IsIn(['openai']) provider!: 'openai';
  @IsString() @MaxLength(2000) baseUrl!: string;
  @IsString() @MaxLength(16000) apiKey!: string;
}

export class ModelProbeDto extends ConnectionDto {
  @IsString() @IsNotEmpty() @MaxLength(200) model!: string;
}

@Controller('providers')
@UseGuards(LocalApiGuard)
export class ProvidersController {
  constructor(
    @Inject(ProvidersService) private readonly providers: ProvidersService,
    @Inject(AiService) private readonly ai: AiService,
  ) {}

  @Post('models')
  list(@Body() input: ConnectionDto) {
    if (!providerEndpointSchema.safeParse(input.baseUrl).success)
      throw new BadRequestException('Invalid provider endpoint.');
    return this.providers.discover(input, true);
  }

  @Post('verify')
  async verify(@Body() input: ModelProbeDto) {
    if (!providerEndpointSchema.safeParse(input.baseUrl).success)
      throw new BadRequestException('Invalid provider endpoint.');
    const signal = AbortSignal.timeout(15_000);
    const catalog = await this.providers.discover(input, true, signal);
    if (!catalog.some((model) => model.id === input.model))
      throw new BadRequestException('This model is missing from the provider catalog.');
    let verified = false;
    try {
      const probe = this.ai.generate(
        [{ role: 'user', content: 'Call verify_connection with ok set to true.' }],
        signal,
        { id: input.model, connection: { baseUrl: input.baseUrl, apiKey: input.apiKey } },
        'This is a connection test. Call the requested function.',
        {
          verify_connection: tool({
            inputSchema: jsonSchema({
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            }),
          }),
        },
        'verify_connection',
      );
      for await (const event of probe.stream) {
        if (event.type === 'error') throw event.error;
        if (
          event.type === 'tool-call' &&
          event.toolName === 'verify_connection' &&
          event.input &&
          typeof event.input === 'object' &&
          'ok' in event.input &&
          event.input.ok === true
        )
          verified = true;
      }
    } catch (error) {
      throw new BadGatewayException(providerError(error));
    }
    if (!verified)
      throw new BadGatewayException(
        'The model did not return the expected streaming function call.',
      );
    return { verified: true };
  }
}
