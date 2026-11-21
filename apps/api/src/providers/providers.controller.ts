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
import { jsonSchema, tool, type ModelMessage } from 'ai';
import { createHash, randomUUID } from 'node:crypto';
import { openAIRuntimeFeatureSchema, providerEndpointSchema } from '@aria/shared';
import { AiService, nativeToolSearch, providerError } from '../ai/ai.service';
import { LocalApiGuard } from '../chat/local-api.guard';
import { ModelRegistry, officialConnection } from './model-registry.service';
import { OpenAIRuntime } from './openai-runtime';
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
    @Inject(ModelRegistry) private readonly models: ModelRegistry,
  ) {}

  @Post('models')
  list(@Body() input: ConnectionDto) {
    if (!providerEndpointSchema.safeParse(input.baseUrl).success)
      throw new BadRequestException('Invalid provider endpoint.');
    return this.providers.discover(input, true);
  }

  @Post('verify-native-runtime')
  async verifyNativeRuntime(@Body() body: { feature?: unknown }) {
    const parsed = openAIRuntimeFeatureSchema.safeParse(body.feature);
    if (!parsed.success) throw new BadRequestException('Select an OpenAI runtime mode.');
    const feature = parsed.data;
    const signal = AbortSignal.timeout(35_000);
    const { primary } = await this.models.resolve(signal, undefined, false, true);
    if (!officialConnection(primary.connection.baseUrl))
      throw new BadRequestException(
        'Native runtime tools require the official OpenAI Responses endpoint.',
      );
    const runtime = new OpenAIRuntime(primary);
    const marker = 'aria-runtime-probe-17';
    try {
      if (feature === 'hosted-shell') await runtime.openHosted([], [], [], signal);
      else if (feature === 'local-shell') runtime.openLocal(randomUUID());
      else {
        const bytes = Buffer.from(
          `Aria verification document. The synthetic reference number is ${marker}.`,
        );
        await runtime.prepareSearch(
          [
            {
              file: { id: randomUUID(), name: 'aria-probe.txt', mimeType: 'text/plain', bytes },
              version: createHash('sha256').update(bytes).digest('hex'),
            },
          ],
          signal,
        );
      }
      const shell = feature !== 'file-search';
      const name = shell ? 'aria_native_shell' : 'aria_native_file_search';
      const tools = runtime.tools();
      const messages: ModelMessage[] = [
        {
          role: 'user',
          content: shell
            ? `Use the provided shell to run printf '${marker}' exactly once.`
            : 'Use the file search tool to find the synthetic reference number in the supplied document.',
        },
      ];
      const run = this.ai.generate(
        messages,
        signal,
        primary,
        'This is a synthetic capability probe.',
        tools,
        name,
        false,
        { fileSearch: !shell, toolLimit: 1 },
      );
      let verified = false;
      let localId: string | undefined;
      for await (const part of run.stream) {
        if (part.type === 'error') throw part.error;
        if (
          part.type === 'tool-call' &&
          part.toolName === name &&
          feature === 'local-shell' &&
          !part.providerExecuted
        )
          localId = part.toolCallId;
        if (part.type === 'tool-result' && part.toolName === name) {
          verified ||= shell
            ? JSON.stringify(part.output).includes(marker)
            : runtime.evidence(part.output).some((item) => item.excerpt.includes(marker));
        }
      }
      if (localId) {
        const response = await run.response;
        messages.push(...response.messages.filter((message) => message.role === 'assistant'), {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: localId,
              toolName: name,
              output: {
                type: 'json',
                value: {
                  output: [{ stdout: marker, stderr: '', outcome: { type: 'exit', exitCode: 0 } }],
                },
              },
            },
          ],
        });
        const continuation = this.ai.generate(
          messages,
          signal,
          primary,
          'Report the verified synthetic shell result.',
          tools,
          undefined,
          true,
        );
        for await (const part of continuation.stream) {
          if (part.type === 'error') throw part.error;
          if (part.type === 'text-delta') verified = true;
        }
      }
      if (!verified) throw new Error('Missing native runtime result.');
      return { feature, verified: true };
    } catch {
      throw new BadGatewayException(
        'The configured OpenAI primary did not pass the runtime probe. Check model and account capabilities.',
      );
    } finally {
      await runtime.close();
    }
  }

  @Post('verify-tool-search')
  async verifyToolSearch() {
    const signal = AbortSignal.timeout(20_000);
    const { primary } = await this.models.resolve(signal, undefined, false, true);
    if (!officialConnection(primary.connection.baseUrl))
      throw new BadRequestException(
        'Native Tool Search requires the official OpenAI Responses endpoint.',
      );
    const search = nativeToolSearch({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    const parameters = { type: 'object', properties: {}, additionalProperties: false } as const;
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: 'Call tool_search now to load the test tool, then call aria_search_probe.',
      },
    ];
    try {
      const initial = this.ai.generate(
        messages,
        signal,
        primary,
        'This is a synthetic Tool Search verification.',
        { tool_search: search },
      );
      let callId: string | undefined;
      for await (const part of initial.stream) {
        if (part.type === 'error') throw part.error;
        if (
          part.type === 'tool-call' &&
          part.toolName === 'tool_search' &&
          !part.providerExecuted &&
          part.input &&
          typeof part.input === 'object' &&
          'call_id' in part.input &&
          part.input.call_id === part.toolCallId
        )
          callId = part.toolCallId;
      }
      if (!callId) throw new Error('Missing native search call.');
      messages.push(
        ...(await initial.response).messages.filter((message) => message.role === 'assistant'),
      );
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'tool_search',
            toolCallId: callId,
            output: {
              type: 'json',
              value: {
                tools: [
                  {
                    type: 'namespace',
                    name: 'aria_probe',
                    description: 'Synthetic compatibility test',
                    tools: [
                      {
                        type: 'function',
                        name: 'aria_search_probe',
                        description: 'Complete the synthetic test.',
                        parameters,
                        defer_loading: true,
                        strict: true,
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      });
      const continued = this.ai.generate(
        messages,
        signal,
        primary,
        'Complete the synthetic verification by calling the tool just loaded.',
        {
          tool_search: search,
          aria_search_probe: tool({
            inputSchema: jsonSchema(parameters),
            providerOptions: { openai: { omitFromRequestTools: true } },
          }),
        },
      );
      let verified = false;
      for await (const part of continued.stream) {
        if (part.type === 'error') throw part.error;
        if (
          part.type === 'tool-call' &&
          part.toolName === 'aria_search_probe' &&
          part.providerMetadata?.openai?.namespace === 'aria_probe' &&
          !part.providerExecuted
        )
          verified = true;
      }
      if (!verified) throw new Error('Missing deferred probe call.');
      return { verified: true };
    } catch {
      throw new BadGatewayException(
        'This primary failed the native Tool Search probe. Review the model in AI Models or select Aria discovery.',
      );
    }
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
