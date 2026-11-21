import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const handle = 'e5d43bf1-8da1-4f4b-81ba-540bd6f5cd44';
type Frame = {
  type: string;
  id?: number;
  input?: { value: number };
  handle?: string;
  code?: string;
  value?: unknown;
};

async function run(
  code: string,
  onCall?: (frame: Frame, reply: (id: number, value: unknown) => void) => void,
  milliseconds = 2000,
) {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', fileURLToPath(new URL('./runner.mts', import.meta.url))],
    {
      stdio: ['pipe', 'pipe', 'ignore'],
      signal: AbortSignal.timeout(5000),
    },
  );
  const frames: Frame[] = [];
  const lines = createInterface({ input: child.stdout });
  const write = (value: object) => child.stdin.write(JSON.stringify(value) + '\n');
  const exit = once(child, 'close');
  lines.on('line', (line) => {
    const frame: Frame = JSON.parse(line);
    frames.push(frame);
    if (frame.type === 'call') onCall?.(frame, (id, value) => write({ id, value }));
  });
  write({ code, bindings: { 'test.echo': handle }, toolCalls: 5, milliseconds });
  const [status] = await exit;
  assert.equal(status, 0);
  return frames;
}

test('coordinates async fan-out and dependent results through the only binding', async () => {
  const ids: number[] = [];
  const frames = await run(
    `
    const results = await Promise.all([2, 1].map(value => tools.invoke('test.echo', { value })));
    const sum = results.reduce((total, reply) => total + reply, 0);
    const total = await tools.invoke('test.echo', { value: sum });
    return { total, order: results.toSorted(), valid: total === 6 };
  `,
    (frame, reply) => {
      assert.equal(frame.handle, handle);
      ids.push(frame.id!);
      if (ids.length === 2) {
        reply(ids[1], 2);
        reply(ids[0], 4);
      } else if (ids.length === 3) reply(frame.id!, frame.input!.value);
    },
  );
  assert.deepEqual(frames.at(-1), {
    type: 'result',
    value: { total: 6, order: [2, 4], valid: true },
  });
  assert.deepEqual(ids, [1, 2, 3]);
});

test('keeps host APIs and undeclared tools outside the guest', async () => {
  const frames = await run(`
    let blocked = false;
    try { await tools.invoke('private.files', { path: '/synthetic' }); }
    catch { blocked = true; }
    return { blocked, host: [typeof process, typeof require, typeof fetch, typeof WebSocket] };
  `);
  assert.deepEqual(frames, [
    {
      type: 'result',
      value: { blocked: true, host: ['undefined', 'undefined', 'undefined', 'undefined'] },
    },
  ]);
});

test('terminates an unbounded program', async () => {
  const frames = await run('while (true) {}', undefined, 40);
  assert.deepEqual(frames, [{ type: 'failure', code: 'BUDGET_EXCEEDED' }]);
});
