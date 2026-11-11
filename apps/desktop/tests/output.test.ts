import { expect, it } from 'vitest';
import { outputLines } from '../src/services/output';
it('preserves lines across arbitrary chunk boundaries and separates stderr', () => {
  const chunks = [
    { id: 'a', stream: 'stdout' as const, sequence: 1, text: 'hel' },
    { id: 'b', stream: 'stdout' as const, sequence: 2, text: 'lo\nworld\n' },
    { id: 'c', stream: 'stderr' as const, sequence: 3, text: 'warning\n' },
  ];
  expect(outputLines(chunks).map((line) => [line.stream, line.text])).toEqual([
    ['stdout', 'hello'],
    ['stdout', 'world'],
    ['stderr', 'warning'],
  ]);
});
it('handles a long command output without spreading rows onto the call stack', () => {
  const rows = outputLines([
    {
      id: 'large',
      stream: 'stdout',
      sequence: 1,
      text: 'a'.repeat(100000) + '\n' + 'line\n'.repeat(50000),
    },
  ]);
  expect(rows).toHaveLength(50001);
  expect(rows[0].text).toHaveLength(100000);
});
