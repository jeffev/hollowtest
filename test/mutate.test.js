import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findMutants } from '../src/mutate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleDir = path.join(here, 'mutation-sample');
const bin = path.join(here, '..', 'bin', 'hollowtest.js');

test('findMutants proposes operator, condition, literal and return mutations', () => {
  const code = 'export function f(a, b) {\n  if (a > b && !a) return a + 1;\n  return true;\n}\nconsole.log(a === b);\n';
  const labels = findMutants(code, 'f.js').map((m) => m.label);
  for (const l of ['> → >=', '&& → ||', 'remove !', 'if (…) → if (true)', 'return … → return null', 'true → false', '1 → 2']) assert.ok(labels.includes(l), `missing ${l} in ${labels}`);
  assert.ok(!labels.includes('=== → !=='), 'console.log arguments must not be mutated');
});

test('hollowtest-ignore comments skip a line', () => {
  const code = 'const x = a > b; // hollowtest-ignore\nconst y = a < b;\n';
  const lines = findMutants(code, 'x.js').map((m) => m.line);
  assert.ok(!lines.includes(1));
  assert.ok(lines.includes(2));
});

test('--mutate finds the function covered only by a hollow test, and restores the source', () => {
  const before = fs.readFileSync(path.join(sampleDir, 'pricing.js'), 'utf8');
  const r = spawnSync(process.execPath, [bin, '--mutate', '.', '--json'], { cwd: sampleDir, encoding: 'utf8', timeout: 240_000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const survivors = out.results.filter((m) => m.status === 'survived');
  assert.ok(survivors.length >= 3, 'expected surviving mutants in discount()');
  // every survivor is inside discount() (lines 10-15); subtotal and shipping are well tested
  assert.ok(survivors.every((m) => m.line >= 10 && m.line <= 15), JSON.stringify(survivors.map((m) => m.line)));
  assert.ok(out.score < 100 && out.score > 0);
  assert.equal(fs.readFileSync(path.join(sampleDir, 'pricing.js'), 'utf8'), before, 'source must be restored');
  assert.ok(!fs.existsSync(path.join(sampleDir, '.hollowtest-restore.json')), 'journal must be removed');
});
