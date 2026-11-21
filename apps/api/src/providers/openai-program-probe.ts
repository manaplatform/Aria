import { randomUUID } from 'node:crypto';
import { openai } from '@ai-sdk/openai';
import { jsonSchema, tool, type ModelMessage, type ToolResultPart, type ToolSet } from 'ai';
import type { ProgramSettings, ToolDiscovery } from '@aria/shared';
import { AiService, nativeToolSearch } from '../ai/ai.service';
import { ToolError } from '../conductor/capability-host';
import { programWireOutput } from '../conductor/program-broker';
import { hostedProgramName, OpenAIProgramTransport } from './openai-program';
import type { ResolvedModel } from './model-registry.service';

export async function verifyOpenAIProgram(
  ai: AiService,
  primary: ResolvedModel,
  continuation: ProgramSettings['continuation'],
  discovery: ToolDiscovery,
  signal: AbortSignal,
) {
  const deferred = discovery === 'openai-responses';
  const name = 'aria_program_probe';
  const marker = randomUUID();
  const parameters = {
    type: 'object',
    properties: { value: { type: 'number' } },
    required: ['value'],
    additionalProperties: false,
  } as const;
  const output = JSON.parse(JSON.stringify(programWireOutput));
  const feature = {
    [hostedProgramName]: openai.tools.programmaticToolCalling(),
    [name]: tool({
      description: 'Return the synthetic marker for the value 21 as data.marker.',
      inputSchema: jsonSchema(JSON.parse(JSON.stringify(parameters))),
      providerOptions: {
        openai: {
          allowedCallers: ['programmatic'],
          outputSchema: output,
          ...(deferred && { omitFromRequestTools: true }),
        },
      },
    }),
  };
  const discoveryTools: ToolSet = deferred
    ? {
        tool_search: nativeToolSearch({
          type: 'object',
          properties: { ids: { type: 'array', items: { type: 'string' } } },
          required: ['ids'],
          additionalProperties: false,
        }),
      }
    : {};
  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: deferred
        ? 'Use Tool Search now to load aria_program_probe. Then run a JavaScript program that calls the loaded function with {value:21}, emits its returned data.marker, and finally replies with the marker.'
        : 'Run a JavaScript program that calls aria_program_probe with {value:21}, emits the returned data.marker, and finally replies with the marker.',
    },
  ];
  const transport = new OpenAIProgramTransport(continuation);
  const programIds = new Set<string>();
  let discovered = !deferred;
  let child = false;
  let complete = false;
  for (let index = 0; index < 6; index++) {
    const current = discovered ? feature : {};
    transport.begin(
      new Map([
        [
          name,
          {
            allowed_callers: ['programmatic'],
            output_schema: programWireOutput,
          },
        ],
      ]),
    );
    const response = ai.generate(
      messages,
      signal,
      primary,
      'Use only synthetic data. Follow the requested provider verification steps.',
      { ...discoveryTools, ...current },
      undefined,
      false,
      { toolLimit: 4, fileSearch: false, program: transport },
    );
    let text = '';
    const calls: { id: string; name: string }[] = [];
    for await (const part of response.stream) {
      if (part.type === 'error') throw part.error;
      if (part.type === 'raw') transport.accept(part.rawValue);
      if (part.type === 'text-delta') text += part.text;
      if (part.type === 'tool-call' && !part.providerExecuted)
        calls.push({ id: part.toolCallId, name: part.toolName });
    }
    const round = transport.end();
    for (const program of round.programs) programIds.add(program.call_id);
    for (const result of round.outputs)
      complete ||=
        programIds.has(result.call_id) &&
        result.status === 'completed' &&
        result.result.includes(marker);
    if (!calls.length && round.final) {
      if (child && complete && text.includes(marker)) return true;
      break;
    }
    const results: ToolResultPart[] = [];
    for (const call of calls) {
      if (!discovered && call.name === 'tool_search') {
        discovered = true;
        results.push({
          type: 'tool-result',
          toolCallId: call.id,
          toolName: call.name,
          output: {
            type: 'json',
            value: {
              tools: [
                {
                  type: 'namespace',
                  name: 'aria_probe',
                  description: 'Synthetic verification',
                  tools: [
                    {
                      type: 'function',
                      name,
                      description: 'Return a synthetic marker.',
                      parameters: JSON.parse(JSON.stringify(parameters)),
                      strict: false,
                      defer_loading: true,
                      allowed_callers: ['programmatic'],
                      output_schema: JSON.parse(JSON.stringify(output)),
                    },
                  ],
                },
              ],
            },
          },
        });
        continue;
      }
      const invocation = round.children.find((entry) => entry.call_id === call.id);
      if (
        call.name !== name ||
        invocation?.caller?.type !== 'program' ||
        !programIds.has(invocation.caller.caller_id) ||
        (deferred && invocation.namespace !== 'aria_probe') ||
        JSON.parse(invocation.arguments).value !== 21
      )
        throw new ToolError(
          'CALLER_MISMATCH',
          'The provider did not call the synthetic function from its program.',
        );
      child = true;
      results.push({
        type: 'tool-result',
        toolCallId: call.id,
        toolName: call.name,
        output: { type: 'json', value: { status: 'completed', data: { marker } } },
        providerOptions: {
          openai: { caller: { type: 'program', callerId: invocation.caller.caller_id } },
        },
      });
    }
    const modelResponse = await response.response;
    messages.push(...modelResponse.messages.filter((message) => message.role === 'assistant'));
    if (results.length) messages.push({ role: 'tool', content: results });
    transport.addResults(results.map(({ toolCallId }) => toolCallId));
  }
  return false;
}
