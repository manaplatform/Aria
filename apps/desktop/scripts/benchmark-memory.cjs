const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryStore } = require('../dist-electron/memory/store.js');
const { WorkingContext } = require('../dist-electron/memory/working-context.js');
const { selectChatContext } = require('@aria/shared');

const sizes = process.argv.slice(2).map(Number);
const counts = sizes.length ? sizes : [1000, 10_000, 100_000];
const dimensions = 384;
const model = 'synthetic-384-v1';

function percentile(samples, ratio) {
  const sorted = [...samples].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(ratio * sorted.length) - 1].toFixed(3));
}

function measure(count, run) {
  const samples = Array.from({ length: count }, (_, index) => {
    const started = performance.now();
    run(index);
    return performance.now() - started;
  });
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
}

function seed(store, count) {
  const write = store.db.prepare(`
    INSERT INTO memories (id,profile,scope,category,checksum,state,observed,created,content,payload)
    VALUES (?,?,?,?,?,'active',?,?,?,?)
  `);
  const vector = store.db.prepare('INSERT INTO vectors VALUES (?,?,?,?)');
  const bytes = Buffer.alloc(dimensions * 4);
  const observedAt = Date.now();
  for (let start = 0; start < count; start += 1000) {
    store.transaction(() => {
      for (let index = start; index < Math.min(count, start + 1000); index++) {
        const id = randomUUID();
        const scope = index % 2 ? { kind: 'profile' } : { kind: 'project', id: 'studio' };
        const key = scope.kind === 'profile' ? 'profile' : 'project:studio';
        const value = {
          category: 'preference',
          content: `Studio workshop notes topic${index % 400} entry${index}`,
        };
        write.run(
          id,
          store.profile,
          key,
          value.category,
          id,
          observedAt,
          observedAt,
          value.content,
          JSON.stringify({
            id,
            revision: 1,
            value,
            scope,
            confidence: 1,
            observedAt,
            state: 'active',
          }),
        );
        for (let dimension = 0; dimension < dimensions; dimension++)
          bytes.writeFloatLE(
            Math.sin(index * 0.017 + dimension) / Math.sqrt(dimensions / 2),
            dimension * 4,
          );
        vector.run(id, model, dimensions, bytes);
      }
    });
  }
  store.db.exec(
    "INSERT INTO memory_fts(memory_fts) VALUES ('optimize'); PRAGMA wal_checkpoint(TRUNCATE);",
  );
}

function benchmark(count) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'aria-memory-bench-'));
  let store = new MemoryStore(directory);
  try {
    seed(store, count);
    const access = { projectId: 'studio', conversationId: 'workshop' };
    const context = new WorkingContext();
    const timestamp = new Date().toISOString();
    const previous = Array.from({ length: 151 }, (_, index) => ({
      id: String(index),
      content: 'Studio workshop note. '.repeat(48),
      createdAt: timestamp,
      role: index % 2 ? 'assistant' : 'user',
      status: 'completed',
    }));
    context.capture('workshop', previous, 41, 0);
    const query = { query: 'entry1', match: 'phrase' };
    const warmWorking = measure(2000, () => context.get('workshop'));
    const baselineContext = measure(2000, () => selectChatContext(previous, ''));
    const workingRebuild = measure(120, () => context.capture('workshop', previous, 41, 0));
    const coldLexical = measure(20, (index) => {
      if (index) store.close();
      store = new MemoryStore(directory);
      store.search(access, { ...query, query: `entry${19 + index}` });
    });
    store.search(access, query);
    const cached = measure(400, () => store.search(access, query));
    const warmLexical = measure(70, (index) =>
      store.search(access, { ...query, query: `entry${100 + index}` }),
    );
    const frequentLexical = measure(50, (index) =>
      store.search(access, { query: `workshop topic${index}`, match: 'terms' }),
    );
    const vector = Array.from({ length: dimensions }, (_, index) => Math.sin(index));
    const hybrid = () => store.search(access, query, store.dense(access, query, model, vector));
    const coldHybrid = measure(5, () => {
      store.close();
      store = new MemoryStore(directory);
      hybrid();
    });
    const warmHybrid = measure(14, hybrid);
    return {
      count,
      baselineContext,
      warmWorking,
      workingRebuild,
      cached,
      coldLexical,
      warmLexical,
      frequentLexical,
      coldHybrid,
      warmHybrid,
      databaseBytes: store.diagnostics().databaseBytes,
    };
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

console.log(
  JSON.stringify(
    {
      hardware: os.cpus()[0]?.model,
      architecture: os.arch(),
      os: os.release(),
      node: process.version,
      memoryBytes: os.totalmem(),
      dimensions,
      units: 'ms',
      results: counts.map(benchmark),
    },
    null,
    2,
  ),
);
