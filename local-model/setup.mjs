import { spawnSync } from 'node:child_process';
import path from 'node:path';
const folder = path.resolve('data/local-model-venv');
const python = process.env.MNEMONIC_PYTHON || 'python3';
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
run(python, ['-m', 'venv', folder]);
run(path.join(folder, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
  ['-m', 'pip', 'install', '-r', 'local-model/requirements.txt']);
