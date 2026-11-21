import { openai } from '@ai-sdk/openai';
import { randomInt } from 'node:crypto';
import { jsonSchema, tool, type ModelMessage, type ToolResultPart, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  computerAction,
  computerLimits,
  computerProviderCall,
  type ComputerImage,
} from '@aria/shared';
import type { AiService } from '../ai/ai.service';
import type { ResolvedModel } from './model-registry.service';

export const nativeComputerName = 'aria_native_computer';
export const nativeComputerTools: ToolSet = { [nativeComputerName]: openai.tools.computer() };

const callInput = z.object({
  status: z.literal('completed'),
  actions: z.array(z.record(z.string(), z.unknown())).min(1).max(computerLimits.actions),
  pendingSafetyChecks: computerProviderCall.shape.checks,
});

export function readComputerCall(input: unknown) {
  const parsed = callInput.safeParse(input);
  if (!parsed.success) return;
  const actions = z.array(computerAction).safeParse(
    parsed.data.actions.map((action) => {
      const adjusted = { ...action };
      if (Array.isArray(adjusted.keys) && !adjusted.keys.length) delete adjusted.keys;
      if (adjusted.type === 'click' && adjusted.button === 'wheel') adjusted.button = 'middle';
      return adjusted;
    }),
  );
  if (actions.success) return { actions: actions.data, checks: parsed.data.pendingSafetyChecks };
}

export function computerScreenshot(
  bytes: Uint8Array,
  checks: z.infer<typeof computerProviderCall.shape.checks>,
): ToolResultPart['output'] {
  return {
    type: 'json',
    value: {
      output: {
        type: 'computer_screenshot',
        imageUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
      },
      acknowledgedSafetyChecks: checks,
    },
  };
}

export function computerImageOutput(
  image: ComputerImage,
  value: unknown,
): ToolResultPart['output'] {
  return {
    type: 'content',
    value: [
      { type: 'text', text: JSON.stringify(value) },
      { type: 'file', mediaType: 'image/png', data: { type: 'data', data: image.bytes } },
    ],
  };
}

const probeImages = [
  [
    'red',
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAQUlEQVR4nO3OQQ0AMBAEofNvupWx8yBBAPfuUvYDISEhoZj9QEhISChmPxASEhKK2Q+EhISEYvYDISEhoZj9oB763xP3eV+LAIgAAAAASUVORK5CYII=',
  ],
  [
    'green',
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAQ0lEQVR4nO3OQQ0AMBAEofMvr4oqY+dBggDu3rXsB0JCQkIx+4GQkJBQzH4gJCQkFLMfCAkJCcXsB0JCQkIx+0E89AEs7mJqnoMuEQAAAABJRU5ErkJggg==',
  ],
  [
    'blue',
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAQUlEQVR4nO3OQQ0AMBAEofNvupWx8yBBAHf3YvYDISEhoZj9QEhISChmPxASEhKK2Q+EhISEYvYDISEhoZj9oB368AX3eWaj93YAAAAASUVORK5CYII=',
  ],
  [
    'yellow',
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAQElEQVR4nO3OQQ0AIAwAsfnXiBfmguPRpAI698xX+oGQkJBQPRASEhKqB0JCQkL1QEhISKgeCAkJCdUDISGhxxaoibPx+Ncr3gAAAABJRU5ErkJggg==',
  ],
];

export async function verifyComputerTransport(
  ai: AiService,
  primary: ResolvedModel,
  native: boolean,
  signal: AbortSignal,
) {
  const name = native ? nativeComputerName : 'aria_observation_probe';
  const tools = native
    ? nativeComputerTools
    : {
        [name]: tool({
          description: 'Return a synthetic image.',
          inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
        }),
      };
  const system =
    'You are verifying synthetic image transport. Request one screenshot using the provided tool. After receiving the screenshot, return only its dominant color as a single word.';
  const messages: ModelMessage[] = [
    { role: 'user', content: 'Request a screenshot and identify its color.' },
  ];
  const [color, encoded] = probeImages[randomInt(probeImages.length)];
  const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
  const first = ai.generate(messages, signal, primary, system, tools, name);
  let id: string | undefined;
  for await (const event of first.stream) {
    if (event.type === 'error') throw event.error;
    if (event.type !== 'tool-call' || event.toolName !== name || event.providerExecuted) continue;
    if (id) return false;
    const call = native ? readComputerCall(event.input) : undefined;
    if (
      native &&
      (!call || call.checks.length || call.actions.some(({ type }) => type !== 'screenshot'))
    )
      return false;
    id = event.toolCallId;
  }
  if (!id) return false;
  const response = await first.response;
  messages.push(...response.messages.filter(({ role }) => role === 'assistant'), {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolName: name,
        toolCallId: id,
        output: native
          ? computerScreenshot(bytes, [])
          : {
              type: 'content',
              value: [
                { type: 'file', mediaType: 'image/png', data: { type: 'data', data: bytes } },
              ],
            },
      },
    ],
  });
  const second = ai.generate(messages, signal, primary, system, tools, undefined, true, {
    fileSearch: false,
    toolLimit: 1,
    computerImages: !native,
  });
  let text = '';
  for await (const event of second.stream) {
    if (event.type === 'error') throw event.error;
    if (event.type === 'text-delta') text += event.text;
  }
  return text.trim().toLowerCase().replace(/\.$/, '') === color;
}
