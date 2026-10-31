import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeProject, findPython } from '../src/index.js';
import { collectFixes, applyFixes } from '../src/fix.js';

function sandbox(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hollowtest-fix-'));
  for (const [name, code] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), code);
  return dir;
}

test('--fix: missing (), missing await (+ async), .only/fit, expect.assertions', () => {
  const dir = sandbox({
    'a.test.js': [
      "describe('s', () => {",
      "  it.only('one', () => {",
      "    expect(f()).toBeNull;",
      '  });',
      "  fit('two', () => {",
      '    expect(load()).resolves.toBe(1);',
      '  });',
      "  it('three', () => {",
      '    try {',
      "      parse('');",
      '    } catch (e) {',
      "      expect(e.message).toBe('empty');",
      '    }',
      '  });',
      '});',
      '',
    ].join('\n'),
  });
  const report = applyFixes(collectFixes(analyzeProject([dir], { cwd: dir }), dir));
  const out = fs.readFileSync(path.join(dir, 'a.test.js'), 'utf8');
  assert.match(out, /^  it\('one'/m);
  assert.match(out, /^  it\('two', async \(\) =>/m);
  assert.match(out, /expect\(f\(\)\)\.toBeNull\(\);/);
  assert.match(out, /await expect\(load\(\)\)\.resolves\.toBe\(1\);/);
  assert.match(out, /it\('three', \(\) => \{\n    expect\.assertions\(1\);\n    try \{/);
  assert.equal(report[0].applied.length, 6);
  // after fixing, none of those findings remain
  const after = analyzeProject([dir], { cwd: dir });
  const rules = after.files.flatMap((f) => [...f.fileFindings, ...f.tests.flatMap((t) => t.findings)]).map((x) => x.rule);
  assert.deepEqual(rules.filter((r) => ['bare-expect', 'unawaited-assertion', 'focused-test', 'swallowed-error'].includes(r)), []);
});

test('--fix --dry-run writes nothing', () => {
  const code = "it.only('x', () => { expect(1 + 1).toBe(2); });\n";
  const dir = sandbox({ 'b.test.js': code });
  const report = applyFixes(collectFixes(analyzeProject([dir], { cwd: dir }), dir), { dryRun: true });
  assert.deepEqual(report[0].applied, ['remove .only']);
  assert.equal(fs.readFileSync(path.join(dir, 'b.test.js'), 'utf8'), code);
});

test('--fix python: assert (cond, msg) becomes assert cond, msg', { skip: findPython() ? false : 'no Python' }, () => {
  const dir = sandbox({ 'test_t.py': 'def test_x():\n    assert (1 + 1 == 3, "math")\n' });
  applyFixes(collectFixes(analyzeProject([dir], { cwd: dir }), dir));
  assert.equal(fs.readFileSync(path.join(dir, 'test_t.py'), 'utf8'), 'def test_x():\n    assert 1 + 1 == 3, "math"\n');
});
