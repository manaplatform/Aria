import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createServer } from 'vite';

const electronPath = createRequire(import.meta.url)('electron') as string;
const vite = await createServer({
  server: { watch: { ignored: ['**/electron/**', '**/dist-electron/**'] } },
});
try {
  await vite.listen();
} catch (error) {
  await vite.close();
  throw error;
}
vite.printUrls();
const devServerUrl = vite.resolvedUrls?.local[0];
if (!devServerUrl) {
  await vite.close();
  throw new Error('Vite did not start a local renderer server.');
}

let electron: ChildProcess | undefined;
let restarting = false;
let stopping = false;

function startElectron() {
  restarting = false;
  const child = spawn(electronPath, ['.'], {
    env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl, ARIA_DEV_LAUNCHER: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    detached: process.platform !== 'win32',
  });
  electron = child;
  const onExit = (code: number | null) => {
    electron = undefined;
    if (restarting && !stopping) startElectron();
    else if (stopping) void vite.close();
    else stop(code ?? 1);
  };
  child.once('exit', onExit);
  child.on('error', (error) => {
    console.error(error);
    if (!child.pid) onExit(1);
  });
}

const host = ts.createWatchCompilerHost(
  'tsconfig.electron.json',
  { noEmitOnError: true },
  ts.sys,
  ts.createEmitAndSemanticDiagnosticsBuilderProgram,
);
const reportWatchStatus = host.onWatchStatusChange;
host.onWatchStatusChange = (diagnostic, newLine, options, errorCount) => {
  reportWatchStatus?.(diagnostic, newLine, options, errorCount);
  if (errorCount !== 0) return;
  if (!electron) {
    startElectron();
  } else if (electron.connected) {
    console.log('Restarting Electron after a successful compile.');
    restarting = true;
    // Electron exits through its normal close path, including the renderer save handshake.
    electron.disconnect();
  }
};
const watch = ts.createWatchProgram(host);

function stop(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  watch.close();
  if (electron?.connected) electron.disconnect();
  else if (!electron) void vite.close();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
