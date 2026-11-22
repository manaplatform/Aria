import { randomUUID } from 'node:crypto';
import { openai } from '@ai-sdk/openai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import type { ProgramSettings, ToolProblem } from '@aria/shared';
import {
  hostedProgramName,
  OpenAIProgramTransport,
  type ProgramWireTool,
} from '../providers/openai-program';
import { ToolError } from './capability-host';
import type { ExecutionEngine } from './execution-engine';
import { programWireOutput, type ProgramBroker, type ProgramExecution } from './program-broker';
import type { ToolDescriptor } from './tool-registry';

export const hostedProgramTool: ToolSet = {
  [hostedProgramName]: openai.tools.programmaticToolCalling(),
};

export class HostedProgramTurn {
  readonly transport: OpenAIProgramTransport;
  private readonly active = new Map<
    string,
    {
      program: ProgramExecution;
      fingerprint: string;
      itemId: string;
    }
  >();
  private readonly finished = new Set<string>();
  private bindings = new Map<string, ToolDescriptor>();
  private owned = new Map<string, ReturnType<OpenAIProgramTransport['end']>['children'][number]>();
  outcome?: ToolProblem;
  completed = 0;
  partial = false;
  final = false;
  finalText?: string;

  constructor(
    retention: ProgramSettings['continuation'],
    private readonly broker: ProgramBroker,
    private readonly engine: ExecutionEngine,
    private readonly requireNamespace: boolean,
  ) {
    this.transport = new OpenAIProgramTransport(retention);
  }

  get pending() {
    return this.active.size > 0;
  }

  prepare(bindings: Map<string, ToolDescriptor>) {
    if (this.pending) {
      if ([...this.bindings].some(([name, entry]) => bindings.get(name) !== entry))
        throw new ToolError(
          'PERMISSION_DENIED',
          'A tool in the hosted program scope was revoked. Start a new authorized program.',
        );
    } else this.bindings = bindings;
    const tools = new Map<string, ProgramWireTool>();
    for (const [name, entry] of this.bindings) {
      tools.set(name, { allowed_callers: [...entry.modes], output_schema: programWireOutput });
    }
    this.transport.begin(tools);
  }

  async receive(wireIDs: readonly string[]) {
    const round = this.transport.end();
    this.final = round.final;
    this.finalText = round.finalText;
    this.owned = new Map();
    for (const item of round.programs) {
      const previous = this.active.get(item.call_id);
      if (previous) {
        if (previous.fingerprint !== item.fingerprint || previous.itemId !== item.id)
          throw new ToolError(
            'CALLER_MISMATCH',
            'OpenAI changed the active program replay fingerprint.',
          );
        continue;
      }
      if (!this.bindings.size || this.finished.has(item.call_id) || this.active.size >= 2)
        throw new ToolError(
          'CALLER_MISMATCH',
          'OpenAI returned a program outside the active scope.',
        );
      this.engine.reserveProgram();
      const program = await this.broker.open(randomUUID(), 'openai-responses', this.bindings);
      this.active.set(item.call_id, { program, fingerprint: item.fingerprint, itemId: item.id });
    }
    for (const item of round.children) {
      if (
        item.caller?.type !== 'program' ||
        !this.active.has(item.caller.caller_id) ||
        this.owned.has(item.call_id) ||
        !wireIDs.includes(item.call_id)
      )
        throw new ToolError(
          'CALLER_MISMATCH',
          'OpenAI returned an unbound program-owned function call.',
        );
      this.owned.set(item.call_id, item);
    }
    for (const output of round.outputs) {
      const active = this.active.get(output.call_id);
      if (
        !active ||
        round.children.some(
          (call) => call.caller?.type === 'program' && call.caller.caller_id === output.call_id,
        )
      )
        throw new ToolError(
          'CALLER_MISMATCH',
          'OpenAI returned an unbound or premature program result.',
        );
      this.active.delete(output.call_id);
      this.finished.add(output.call_id);
      let value: unknown;
      try {
        value = JSON.parse(output.result);
      } catch {
        value = undefined;
      }
      const outcome = await active.program.finish(
        value,
        output.status === 'incomplete'
          ? {
              code: 'CONTINUATION_FAILED',
              message: 'OpenAI stopped before completing the program.',
            }
          : undefined,
      );
      this.completed++;
      this.partial ||= outcome.status !== 'complete';
      this.outcome = outcome.problem ?? this.outcome;
    }
  }

  owns(id: string) {
    return this.owned.has(id);
  }

  async dispatch(id: string, wireName: string, metadata: unknown) {
    const item = this.owned.get(id);
    const mapped = z
      .object({
        openai: z.object({
          caller: z.object({ type: z.literal('program'), callerId: z.string() }),
        }),
      })
      .safeParse(metadata);
    if (
      !item ||
      item.caller?.type !== 'program' ||
      item.name !== wireName ||
      !mapped.success ||
      mapped.data.openai.caller.callerId !== item.caller.caller_id
    )
      throw new ToolError(
        'CALLER_MISMATCH',
        'The SDK and Responses API program callers do not match.',
      );
    const active = this.active.get(item.caller.caller_id);
    if (!active) throw new ToolError('CALLER_MISMATCH', 'The parent OpenAI program is closed.');
    // Namespace is an independent routing identity for client Tool Search definitions.
    const descriptor = this.bindings.get(wireName);
    const binding =
      this.requireNamespace && item.namespace !== descriptor?.id.split('.')[0] ? '' : wireName;
    let args: unknown;
    try {
      args = JSON.parse(item.arguments);
    } catch {
      args = undefined;
    }
    const result = await active.program.invoke(id, binding, args);
    return { result, caller: mapped.data.openai.caller };
  }

  async close(issue: ToolProblem) {
    for (const { program } of this.active.values()) program.stopChildren();
    await Promise.allSettled(
      [...this.active.values()].map(({ program }) =>
        program.finish(undefined, issue, undefined, issue.code === 'CANCELLED'),
      ),
    );
    this.active.clear();
  }
}
