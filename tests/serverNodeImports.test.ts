// Production runs `node server.ts` (native type stripping, no tsx), so every
// module the server reaches must resolve without tsx's extensionless lookup.
// Tests run under tsx and would miss that; this spawns plain node instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

const serverFiles = ['server.ts', ...readdirSync('server').filter((f) => f.endsWith('.ts')).map((f) => `server/${f}`)];

function srcImports(file: string): string[] {
  const dir = file.includes('/') ? '../' : './';
  return [...readFileSync(file, 'utf8').matchAll(/^import (?!type )[^;]*? from ['"]([^'"]+)['"]/gm)]
    .map((m) => m[1])
    .filter((p) => p.startsWith(`${dir}src/`))
    .map((p) => p.slice(dir.length));
}

test('modules imported by the server load under plain node', () => {
  const targets = [...new Set(serverFiles.flatMap(srcImports))];
  assert.ok(targets.length > 0);
  for (const target of targets) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(`./${target}`)})`], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${target} failed under plain node:\n${r.stderr}`);
  }
});
