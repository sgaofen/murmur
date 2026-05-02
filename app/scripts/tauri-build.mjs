import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const requested = args[0];
const bundles = requested || (process.platform === 'darwin' ? 'app' : '');

const tauriArgs = ['build'];
if (bundles) {
  tauriArgs.push('--bundles', bundles);
}

const result = spawnSync('tauri', tauriArgs, {
  cwd: process.cwd(),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
