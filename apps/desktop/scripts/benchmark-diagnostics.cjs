// Run after the desktop build; this is a synthetic logger throughput measurement.
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { Diagnostics } = require('../dist-electron/diagnostics/service.js');

(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aria-log-benchmark-'));
  const logger = new Diagnostics(directory, 'benchmark');
  try {
    await logger.initialize();
    const count = 20_000;
    let started = performance.now();
    for (let i = 0; i < count; i++) logger.log('debug', 'chat', 'execution', 'chat.started');
    const disabledMs = performance.now() - started;
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    started = performance.now();
    for (let batch = 0; batch < count / 500; batch++) {
      for (let i = 0; i < 500; i++)
        logger.log('info', 'chat', 'execution', 'chat.started', {
          requestId: `request-${batch}`,
          correlationId: `request-${batch}`,
        });
      await logger.flush();
    }
    const enabledMs = performance.now() - started;
    delay.disable();
    process.stdout.write(
      JSON.stringify(
        {
          count,
          disabledMs,
          enabledMs,
          maxEventLoopDelayMs: delay.max / 1e6,
          dropped: logger.status().dropped,
          bytes: logger.status().bytes,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
