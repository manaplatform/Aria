import { z } from 'zod';
import type { JSONSchema7 } from 'ai';
import { programLimits, type ProgramSettings } from '@aria/shared';
import { ToolError } from '../conductor/capability-host';

export const hostedProgramName = 'programmatic_tool_calling';
const id = z.string().min(1).max(256);
export const providerProgram = z.object({
  type: z.literal('program'),
  id,
  call_id: id,
  code: z.string().max(64_000),
  fingerprint: z.string().min(1).max(512_000),
});
export const providerProgramResult = z.object({
  type: z.literal('program_output'),
  id,
  call_id: id,
  status: z.enum(['completed', 'incomplete']),
  result: z.string().max(programLimits.result),
});
export const providerProgramCaller = z.object({
  type: z.literal('program'),
  caller_id: id,
});
export const providerFunction = z.object({
  type: z.literal('function_call'),
  id,
  call_id: id,
  name: z.string().min(1).max(64),
  namespace: z.string().optional().nullable(),
  arguments: z.string().max(programLimits.frame),
  caller: z
    .union([providerProgramCaller, z.strictObject({ type: z.literal('direct') })])
    .optional()
    .nullable(),
});
const wireItem = z.looseObject({ type: z.string().max(80) });
type Item = z.infer<typeof wireItem>;
type ResponseRound = {
  id: string;
  status: string;
  items: Item[];
};
const replyTypes = new Set([
  'function_call_output',
  'tool_search_output',
  'shell_call_output',
  'computer_call_output',
  'custom_tool_call_output',
]);

export type ProgramWireTool = {
  allowed_callers: ('direct' | 'programmatic')[];
  output_schema?: JSONSchema7;
};

/** Keeps provider-only replay items out of Conductor messages, activity and logs. */
export class OpenAIProgramTransport {
  private history: Item[] = [];
  private readonly finished = new Map<number, Item>();
  private previous?: ResponseRound;
  private results = new Set<string>();
  private exposed = new Map<string, ProgramWireTool>();
  private response?: ResponseRound;

  constructor(readonly retention: ProgramSettings['continuation']) {}

  get hasContinuation() {
    return Boolean(this.previous);
  }

  get storedResponseId() {
    return this.retention === 'stored' ? this.previous?.id : undefined;
  }

  begin(tools: ReadonlyMap<string, ProgramWireTool>) {
    this.exposed = new Map(tools);
    this.finished.clear();
    this.response = undefined;
  }

  addResults(callIds: string[]) {
    this.results = new Set(callIds);
  }

  accept(chunk: unknown) {
    const event = z
      .object({
        type: z.string(),
        output_index: z.number().int().min(0).max(48).optional(),
        item: wireItem.optional(),
        response: z
          .object({
            id,
            status: z.string().optional(),
            output: z.array(wireItem).max(48).optional(),
          })
          .optional(),
      })
      .safeParse(chunk);
    if (!event.success) return;
    const value = event.data;
    if (
      value.type === 'response.output_item.done' &&
      value.item &&
      value.output_index !== undefined
    ) {
      this.finished.set(value.output_index, value.item);
    }
    if (
      [
        'response.completed',
        'response.incomplete',
        'response.failed',
        'response.cancelled',
      ].includes(value.type) &&
      value.response
    ) {
      const terminal = value.type.slice('response.'.length);
      this.response = {
        id: value.response.id,
        status: value.response.status && value.response.status !== terminal ? 'invalid' : terminal,
        items: value.response.output?.length
          ? value.response.output
          : [...this.finished].sort(([a], [b]) => a - b).map(([, item]) => item),
      };
    }
  }

  end() {
    const response = this.response;
    if (!response || response.status !== 'completed')
      throw new ToolError(
        'CONTINUATION_FAILED',
        response?.status === 'incomplete'
          ? 'OpenAI returned an incomplete response. No calls from that response were dispatched.'
          : 'OpenAI did not finish the program response stream.',
      );
    const { items } = response;
    if (Buffer.byteLength(JSON.stringify(items)) > 800_000)
      throw new ToolError(
        'BUDGET_EXCEEDED',
        'The OpenAI program continuation exceeds its size limit.',
      );
    const programs = items
      .filter((item) => item.type === 'program')
      .map((item) => providerProgram.parse(item));
    const outputs = items
      .filter((item) => item.type === 'program_output')
      .map((item) => providerProgramResult.parse(item));
    const children = items
      .filter(
        (item) =>
          item.type === 'function_call' &&
          Boolean(item.caller) &&
          (item.caller as { type?: string }).type !== 'direct',
      )
      .map((item) => providerFunction.parse(item));
    const message = items.filter(
      (item) =>
        item.type === 'message' &&
        item.role === 'assistant' &&
        item.phase !== 'commentary' &&
        (item.status === 'completed' || item.status === undefined) &&
        Array.isArray(item.content) &&
        item.content.some((part: Item) => part.type === 'output_text' || part.type === 'refusal'),
    ).at(-1);
    const finalText = message
      ? (message.content as Item[]).flatMap((part) => {
          if (part.type === 'output_text' && typeof part.text === 'string') return [part.text];
          if (part.type === 'refusal' && typeof part.refusal === 'string') return [part.refusal];
          return [];
        }).join('\n').slice(0, 100_000)
      : undefined;
    this.previous = response;
    return { programs, outputs, children, final: Boolean(message), finalText };
  }

  serialize(body: Record<string, unknown>, system: string) {
    const encoded = Array.isArray(body.input) ? (body.input as Item[]) : [];
    const stored = this.retention === 'stored';
    const requestTools = Array.isArray(body.tools) ? this.definitions(body.tools) : undefined;
    const request = { ...body, ...(requestTools && { tools: requestTools }) };
    const patchDefinitions = (items: Item[]) =>
      items.map((item) =>
        item.type === 'tool_search_output' && Array.isArray(item.tools)
          ? { ...item, tools: this.definitions(item.tools) }
          : item,
      );
    if (!this.previous) {
      this.history = patchDefinitions(encoded);
      return { ...request, store: stored, input: this.history };
    }
    const results = encoded.filter(
      (item) =>
        replyTypes.has(item.type) &&
        typeof item.call_id === 'string' &&
        this.results.has(item.call_id),
    );
    if (new Set(results.map((value) => value.call_id)).size !== this.results.size)
      throw new ToolError(
        'CONTINUATION_FAILED',
        'Could not correlate each OpenAI continuation result.',
      );
    if (stored) {
      return {
        ...request,
        store: true,
        previous_response_id: this.previous.id,
        instructions: system,
        input: patchDefinitions(results),
      };
    }
    const initial = this.history[0];
    const instructions = initial && (initial.role === 'system' || initial.role === 'developer');
    if (instructions && encoded[0]?.role === initial.role) this.history[0] = encoded[0];
    this.history = patchDefinitions([...this.history, ...this.previous.items, ...results]);
    if (Buffer.byteLength(JSON.stringify(this.history)) > 1_500_000)
      throw new ToolError('BUDGET_EXCEEDED', 'The OpenAI program history exceeds its size limit.');
    return { ...request, store: false, input: this.history };
  }

  private definitions(tools: Item[]): Item[] {
    return tools.map((item) => {
      if (item.type === 'namespace' && Array.isArray(item.tools))
        return { ...item, tools: this.definitions(item.tools) };
      if (item.type === 'function' && typeof item.name === 'string') {
        const definition = this.exposed.get(item.name);
        if (definition) return { ...item, ...definition };
        if (Array.isArray(item.allowed_callers)) return { ...item, allowed_callers: ['direct'] };
      }
      return item;
    });
  }
}
