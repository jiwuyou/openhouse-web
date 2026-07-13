import { chmod, cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist');
const executableScripts = new Set([
  'scripts/install.sh',
  'scripts/check.sh',
  'scripts/register-service.sh',
]);

async function normalizeModes(directory, relative = '') {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const targetRelative = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      await normalizeModes(target, targetRelative);
    } else {
      await chmod(target, executableScripts.has(targetRelative) ? 0o755 : 0o644);
    }
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true, mode: 0o755 });
for (const directory of ['src', 'public', 'config', 'test']) {
  await cp(path.join(root, directory), path.join(dist, directory), { recursive: true });
}
for (const file of ['README.md', 'package.json']) await cp(path.join(root, file), path.join(dist, file));
await mkdir(path.join(dist, 'scripts'), { recursive: true, mode: 0o755 });
for (const file of ['build.mjs', 'check.mjs', 'install.sh', 'check.sh', 'register-service.sh']) {
  await cp(path.join(root, 'scripts', file), path.join(dist, 'scripts', file));
}
await normalizeModes(dist);
console.log(`runtime built at ${dist}`);
