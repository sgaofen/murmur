import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..');
const cliRoot = join(repoRoot, 'cli');
const distDir = join(cliRoot, 'dist', 'etcli');
const targetDir = join(appRoot, 'src-tauri', 'etcli');
const keepFile = join(targetDir, '.keep');
const keepContents = 'Bundled etcli files are copied here for Tauri builds.\n';
const backendExe = process.platform === 'win32' ? 'etcli.exe' : 'etcli';

function ensurePlaceholder() {
  mkdirSync(targetDir, { recursive: true });
  if (!existsSync(keepFile)) {
    writeFileSync(keepFile, keepContents, 'utf-8');
  }
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: opts.cwd || repoRoot,
    stdio: opts.stdio || 'inherit',
    encoding: 'utf-8',
  });
}

function pythonWithPyInstaller() {
  const candidates = process.platform === 'win32'
    ? ['python', 'py']
    : ['python3.13', 'python3.12', 'python3.11', 'python3'];
  for (const py of candidates) {
    const probe = 'import sys, PyInstaller; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)';
    const args = py === 'py' ? ['-3', '-c', probe] : ['-c', probe];
    const r = run(py, args, { cwd: repoRoot, stdio: 'ignore' });
    if (r.status === 0) return { cmd: py, prefix: py === 'py' ? ['-3'] : [] };
  }
  return null;
}

function backendSourcesAreNewer(expectedExe) {
  const builtAt = statSync(expectedExe).mtimeMs;
  const stack = [cliRoot];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'build' || entry.name === 'dist' || entry.name === '__pycache__') {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if ((entry.name.endsWith('.py') || entry.name.endsWith('.spec')) && statSync(path).mtimeMs > builtAt) {
        return true;
      }
    }
  }
  return false;
}

function copyDistToTauri() {
  const expectedExe = join(distDir, backendExe);
  if (!existsSync(distDir) || readdirSync(distDir).length === 0 || !existsSync(expectedExe)) {
    return false;
  }
  if (backendSourcesAreNewer(expectedExe)) {
    return false;
  }
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  cpSync(distDir, targetDir, { recursive: true });
  writeFileSync(keepFile, keepContents, 'utf-8');
  return true;
}

ensurePlaceholder();

if (copyDistToTauri()) {
  console.log(`[murmur] bundled backend copied from ${distDir}`);
  process.exit(0);
}

const py = pythonWithPyInstaller();
if (!py) {
  console.error('[murmur] PyInstaller is not installed in any Python 3.11+ environment.');
  console.error('[murmur] Install build deps first, then retry:');
  console.error('  python -m pip install --user pyinstaller -r ../requirements.txt');
  console.error('  npm run backend:bundle');
  process.exit(1);
}

console.log(`[murmur] building backend with ${py.cmd} -m PyInstaller cli/etcli.spec`);
const build = run(py.cmd, [...py.prefix, '-m', 'PyInstaller', 'etcli.spec', '--clean', '-y'], { cwd: cliRoot });
if (build.status !== 0) {
  process.exit(build.status || 1);
}

if (!copyDistToTauri()) {
  console.error(`[murmur] PyInstaller finished, but ${distDir} was not created.`);
  process.exit(1);
}

console.log(`[murmur] backend bundle ready at ${targetDir}`);
