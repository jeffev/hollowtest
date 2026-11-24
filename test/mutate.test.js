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

test('--mutate tells code no test runs (unreached) from code the tests run but do not check', () => {
  const r = spawnSync(process.execPath, [bin, '--mutate', '.', '--json'], { cwd: sampleDir, encoding: 'utf8', timeout: 240_000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const unreached = out.results.filter((m) => m.status === 'unreached');
  // loyaltyBonus() (lines 18-21) is never called by any test
  assert.ok(unreached.length >= 3, 'expected unreached mutants in loyaltyBonus()');
  assert.ok(unreached.every((m) => m.line >= 18 && m.line <= 21), JSON.stringify(unreached.map((m) => m.line)));
  assert.equal(out.unreached, unreached.length);
  assert.equal(out.survived, out.mutants - out.killed, 'survived keeps counting every mutant that slipped through');
});

test('--no-probe skips the reachability probes', () => {
  const r = spawnSync(process.execPath, [bin, '--mutate', '.', '--json', '--no-probe'], { cwd: sampleDir, encoding: 'utf8', timeout: 240_000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.unreached, 0);
  assert.ok(out.results.some((m) => m.status === 'survived' && m.line >= 18));
});

const hasPytest = spawnSync(process.env.HOLLOWTEST_PYTHON || 'python', ['-c', 'import pytest'], { encoding: 'utf8' }).status === 0;
const pySampleDir = path.join(here, 'mutation-sample-py');

test('Python mutants: operators, conditions, literals and returns, with offsets that splice cleanly', { skip: !hasPytest && 'needs Python with pytest' }, () => {
  const file = path.join(pySampleDir, 'pricing.py');
  const r = spawnSync(process.env.HOLLOWTEST_PYTHON || 'python', ['-I', path.join(here, '..', 'src', 'python', 'mutate_py.py')], { input: JSON.stringify({ cmd: 'mutants', files: [file] }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const mutants = JSON.parse(r.stdout).mutants[file];
  const src = fs.readFileSync(file, 'utf8');
  const labels = mutants.map((m) => m.label);
  for (const l of ['>= → >', 'and → or', '== → !=', '/ → *', 'if … → if True', 'return … → return None', '100 → 101']) assert.ok(labels.includes(l), `missing ${l} in ${labels}`);
  for (const m of mutants) assert.equal(src.slice(m.start, m.end), m.original, `offsets of ${m.label} on line ${m.line}`);
});

test('--mutate works on Python: survivors in discount(), unreached in loyalty_bonus(), source restored', { skip: !hasPytest && 'needs Python with pytest' }, () => {
  const before = fs.readFileSync(path.join(pySampleDir, 'pricing.py'), 'utf8');
  const r = spawnSync(process.execPath, [bin, '--mutate', 'pricing.py', '--json'], { cwd: pySampleDir, encoding: 'utf8', timeout: 240_000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.runner, /pytest/);
  const survived = out.results.filter((m) => m.status === 'survived');
  const unreached = out.results.filter((m) => m.status === 'unreached');
  assert.ok(survived.length >= 3 && survived.every((m) => m.line >= 11 && m.line <= 14), JSON.stringify(survived.map((m) => m.line)));
  assert.ok(unreached.length >= 3 && unreached.every((m) => m.line >= 17 && m.line <= 20), JSON.stringify(unreached.map((m) => m.line)));
  assert.equal(fs.readFileSync(path.join(pySampleDir, 'pricing.py'), 'utf8'), before, 'source must be restored');
});
