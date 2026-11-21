import { createInterface } from 'node:readline';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant, type QuickJSDeferredPromise } from 'quickjs-emscripten-core';

const maximumFrame = 48_000;

function send(value: object) {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) >= maximumFrame) throw new Error('LIMIT');
  process.stdout.write(line + '\n');
}

async function run() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const input = lines[Symbol.asyncIterator]();
  const first = await input.next();
  if (first.done || Buffer.byteLength(first.value) >= maximumFrame) throw new Error('INPUT');
  const start = JSON.parse(first.value) as {
    code: string;
    bindings: Record<string, string>;
    toolCalls: number;
    milliseconds: number;
  };
  const quickjs = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = quickjs.newRuntime();
  const deadline = performance.now() + Math.min(start.milliseconds, 120_000);
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(() => performance.now() >= deadline);
  const vm = runtime.newContext();
  const pending = new Map<number, QuickJSDeferredPromise>();
  const bindings = new Map(Object.entries(start.bindings));
  let calls = 0;
  let limited = false;
  const invoke = vm.newFunction('invoke', (tool, json) => {
    const handle = bindings.get(vm.getString(tool));
    if (!handle) {
      const error = vm.newString('Tool is outside this program scope.');
      return { error };
    }
    if (++calls > start.toolCalls) {
      limited = true;
      return { error: vm.newString('Program tool call limit reached.') };
    }
    try {
      const value = vm.getString(json);
      if (Buffer.byteLength(value) >= maximumFrame - 256) throw new Error('LIMIT');
      const deferred = vm.newPromise();
      send({ type: 'call', id: calls, handle, input: JSON.parse(value) });
      pending.set(calls, deferred);
      return deferred.handle;
    } catch {
      return { error: vm.newString('Invalid or oversized tool input.') };
    }
  });
  vm.setProp(vm.global, 'ariaInvoke', invoke);
  invoke.dispose();

  // The guest receives a promise of JSON data, never an object from the Node process.
  const code = `
    (async (invoke, stringify, parse) => {
      const tools = Object.freeze({ invoke: async (id, input) =>
        parse(await invoke(id, stringify(input))) });
      const value = await (async (tools) => {
        "use strict";
        ${start.code}
      })(tools);
      return stringify(value);
    })(ariaInvoke, JSON.stringify, JSON.parse)`;
  const evaluation = vm.evalCode(code, 'program.js');
  if (evaluation.error) {
    evaluation.error.dispose();
    throw new Error(performance.now() >= deadline ? 'LIMIT' : 'PROGRAM');
  }
  const result = evaluation.value;
  try {
    for (;;) {
      const jobs = runtime.executePendingJobs(128);
      if (jobs.error) {
        jobs.error.dispose();
        throw new Error(limited || performance.now() >= deadline ? 'LIMIT' : 'PROGRAM');
      }
      if (limited || performance.now() >= deadline) throw new Error('LIMIT');
      const state = vm.getPromiseState(result);
      if (state.type === 'rejected') {
        state.error.dispose();
        throw new Error('PROGRAM');
      }
      if (state.type === 'fulfilled') {
        const value = vm.getString(state.value);
        state.value.dispose();
        if (pending.size || Buffer.byteLength(value) > 12_000) throw new Error('LIMIT');
        send({ type: 'result', value: JSON.parse(value) });
        return;
      }
      if (jobs.value === 128) continue;
      if (!pending.size) throw new Error('PROGRAM');
      const next = await input.next();
      if (next.done || Buffer.byteLength(next.value) >= maximumFrame) throw new Error('INPUT');
      const reply = JSON.parse(next.value) as { id: number; value: unknown };
      const deferred = pending.get(reply.id);
      if (!deferred) throw new Error('INPUT');
      pending.delete(reply.id);
      const value = vm.newString(JSON.stringify(reply.value));
      deferred.resolve(value);
      value.dispose();
      deferred.dispose();
    }
  } finally {
    lines.close();
  }
}

void run().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : '';
  send({ type: 'failure', code: reason === 'LIMIT' ? 'BUDGET_EXCEEDED' : 'INVALID_PROGRAM' });
}).finally(() => {
  process.stdin.destroy();
});
