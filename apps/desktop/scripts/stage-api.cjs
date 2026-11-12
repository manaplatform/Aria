const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const target = path.resolve(__dirname, '../dist-electron/api');
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run the desktop build through pnpm.');
const run = (args) =>
  execFileSync(process.execPath, [pnpm, ...args], { cwd: root, stdio: 'inherit' });
run(['--filter', '@aria/api', 'build']);
fs.rmSync(target, { recursive: true, force: true });
run(['--filter', '@aria/api', 'deploy', '--prod', target]);
// pnpm 9 leaves a workspace self-alias pointing back to the source checkout.
// The executable API never imports itself; remove it to keep this runtime portable.
fs.rmSync(path.join(target, 'node_modules/.pnpm/node_modules/@aria/api'), {
  recursive: true,
  force: true,
});
