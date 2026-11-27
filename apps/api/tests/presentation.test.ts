import { describe, expect, it } from 'vitest';
import { presentationChart, type PresentationPart } from '@aria/shared';
import { PresentationOutput } from '../src/conductor/presentation';
import type { Outcome } from '../src/conductor/execution-engine';

const fence = (input: object, eol = '\n') =>
  ['```aria-ui', JSON.stringify(input), '```', ''].join(eol);
const base = {
  v: 1,
  id: 'test',
  revision: 1,
  roots: ['heading'],
  nodes: [{ id: 'heading', type: 'heading', text: 'Hello' }],
};
function stream(latest = '', outcome?: Outcome, weather = false) {
  const data = { text: '', parts: [] as PresentationPart[], validated: [] as boolean[] };
  const output = new PresentationOutput(
    {
      latest,
      outcome: (id) => (outcome?.id === id ? outcome : undefined),
      hasStep: (id) => id === outcome?.id,
      hasSource: () => false,
      hasWeatherStep: (id) => weather && id === outcome?.id,
    },
    (text) => {
      data.text += text;
    },
    (part) => data.parts.push(part),
    (ok) => data.validated.push(ok),
  );
  return { output, data };
}

describe('Persona presentation stream', () => {
  it('binds weather cards only to a completed weather receipt and rejects injected data', () => {
    const id = 'bd17bada-78cf-4ce1-aa1f-21f6c88d3c1e';
    const timestamp = new Date().toISOString();
    const forecast = { location: { name: 'Oslo', latitude: 59.9, longitude: 10.7, timezone: 'Europe/Oslo' }, kind: 'forecast',
      provider: 'MET Norway', attribution: 'MET Norway', generatedAt: timestamp, retrievedAt: timestamp, freshUntil: timestamp,
      units: { temperature: 'celsius', wind: 'm/s', precipitation: 'mm', humidity: '%', windDirection: 'degrees' } };
    const node = { id: 'weather', type: 'weather', stepId: id, view: 'current' };
    const input = { ...base, roots: ['weather'], nodes: [node] };
    const receipt: Outcome = { id, status: 'completed', data: forecast };
    const accepted = stream('', receipt, true);
    accepted.output.append(fence(input)); accepted.output.finish();
    expect(accepted.data.parts).toMatchObject([{ kind: 'block', block: { nodes: [{ data: forecast }] } }]);
    const injected = stream('', receipt, true);
    injected.output.append(fence({ ...input, nodes: [{ ...node, data: forecast }] })); injected.output.finish();
    expect(injected.data.parts[0].kind).toBe('unavailable');
    const unowned = stream('', receipt);
    unowned.output.append(fence(input)); unowned.output.finish();
    expect(unowned.data.parts[0].kind).toBe('unavailable');
  });
  it('forwards plain text immediately and projects full blocks under arbitrary chunk boundaries', () => {
    const { output, data } = stream();
    output.append('First text');
    expect(data.text).toBe('First text');
    const rest = '\r\n\r\n' + fence(base, '\r\n') + 'Tail';
    for (const character of rest) output.append(character);
    output.finish();
    expect(data.text).toBe('First text\r\n\r\nTail');
    expect(data.parts).toMatchObject([{ kind: 'block', offset: 14, block: base }]);
  });

  it('keeps examples in ordinary fences inert and removes invalid or interrupted reserved blocks', () => {
    const { output, data } = stream();
    const example = '````markdown\n\n' + fence(base) + '````\n\n';
    output.append(example + fence({ ...base, roots: ['missing'] }) + 'Next\n\n```aria-ui\n{"v":1');
    output.finish();
    expect(data.text).toBe(example + 'Next\n\n');
    expect(data.parts.map((part) => part.kind)).toEqual(['unavailable', 'unavailable']);
    expect(data.validated).toEqual([false, false]);
  });

  it('rejects unsafe actions and non-source datasets while retaining the surrounding answer', () => {
    const { output, data } = stream('Sort the numbers.');
    output.append(
      fence({
        ...base,
        actions: [{ id: 'x', label: 'Open', kind: 'link', url: 'javascript:alert(1)' }],
      }),
    );
    output.append(
      fence({
        ...base,
        datasets: [
          {
            id: 'data',
            columns: ['Name', 'Value'],
            data: { kind: 'user', quote: '[["January",5]]' },
          },
        ],
      }),
    );
    output.append(
      fence({
        ...base,
        nodes: [{ id: 'heading', type: 'text', text: 'API key: sk-testabcdefghijklmnopq' }],
      }),
    );
    output.append('Safe text');
    output.finish();
    expect(data.parts.map(({ kind }) => kind)).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
    expect(data.text).toBe('Safe text');
  });

  it('materializes completed receipt data without accepting model-supplied numbers or keys', () => {
    const id = 'bd17bada-78cf-4ce1-aa1f-21f6c88d3c1e';
    const { output, data } = stream('', {
      id,
      status: 'completed',
      data: { metrics: [{ label: 'A', value: 5 }] },
    });
    const inputs = {
      ...base,
      roots: ['chart'],
      nodes: [{ id: 'chart', label: 'Survey', type: 'chart', chart: 'pie', dataset: 'data' }],
      datasets: [
        {
          id: 'data',
          columns: ['Label', 'Value'],
          data: { kind: 'result', stepId: id, path: ['metrics'], keys: ['label', 'value'] },
        },
      ],
    };
    output.append(fence(inputs));
    output.append(fence({ ...inputs, revision: 2 }));
    output.append(fence(inputs));
    output.finish();
    expect(data.parts).toHaveLength(2);
    const part = data.parts[1];
    expect(part).toMatchObject({
      kind: 'block',
      block: { revision: 2, datasets: [{ rows: [['A', 5]], stepId: id }] },
    });
    if (part.kind !== 'block') throw new Error('Expected a validated block');
    const node = part.block.nodes[0];
    if (node.type !== 'chart') throw new Error('Expected chart data');
    expect(presentationChart(node, part.block.datasets![0])).toMatchObject({
      categories: ['A'],
      series: [{ values: [5] }],
    });
  });
});
