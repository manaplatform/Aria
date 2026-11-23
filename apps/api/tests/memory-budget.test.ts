import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type { ModelMessage } from 'ai';
import type { ResolvedModel } from '../src/providers/model-registry.service';

const { TurnBudget } = createRequire(import.meta.url)(
  '../dist/conductor/turn-budget.js',
) as typeof import('../src/conductor/turn-budget');

it('compacts recalled text before dropping the most recent user context or an active tool result', async () => {
  const history: ModelMessage[] = [
    { role: 'user', content: 'Earlier instruction' },
    { role: 'assistant', content: 'Earlier reply' },
    { role: 'user', content: 'Keep the newer exact request.' },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'memory', toolName: 'memory_search',
        output: { type: 'text', value: 'Recall '.repeat(250) } },
      { type: 'tool-result', toolCallId: 'approval', toolName: 'computer_act',
        output: { type: 'text', value: 'The user declined this operation.' } },
    ] },
  ];
  const budget = new TurnBudget();
  const model = { contextTokens: 1000 } as ResolvedModel;
  const prepared = await budget.prepare(history, 2, 'Preserve all instructions.', {}, model, false, true);
  expect(prepared.historicalMessages).toBe(2);
  expect(JSON.stringify(prepared.inputMessages)).toContain('Keep the newer exact request.');
  expect(JSON.stringify(prepared.inputMessages)).toContain('The user declined this operation.');
  expect(JSON.stringify(prepared.inputMessages)).toContain('The memory excerpt exceeded');
  expect(JSON.stringify(prepared.inputMessages)).not.toContain('Recall Recall');
});
