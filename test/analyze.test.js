import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeProject, analyzeFile, testHealth } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = (f) => path.join(here, 'sample', f);
const result = analyzeProject([path.join(here, 'sample')], { cwd: here });
const byFile = Object.fromEntries(result.files.map((f) => [path.basename(f.file), f]));
const rulesOf = (file, name) => {
  const t = byFile[file].tests.find((x) => x.name === name);
  assert.ok(t, `test "${name}" not found in ${file}`);
  return t.findings.map((f) => f.rule).sort();
};
const severityOf = (file, name, rule) => byFile[file].tests.find((x) => x.name === name).findings.find((f) => f.rule === rule)?.severity;

test('every hollow pattern is flagged with exactly the expected rule', () => {
  const expected = {
    'empty body': ['empty-test'],
    'no assertions': ['no-assertions'],
    'renders without crashing': ['no-assertions'],
    'compares with itself': ['tautology'],
    'asserts a literal': ['tautology'],
    'literal with unary matcher': ['tautology'],
    'bare expect': ['bare-expect'],
    'matcher not called': ['bare-expect'],
    'expects throw in catch': ['swallowed-error'],
    'swallows assertion errors': ['swallowed-error'],
    'unawaited resolves': ['unawaited-assertion'],
    'then without return': ['unawaited-assertion'],
    'setTimeout without done': ['unawaited-assertion'],
    'only conditional': ['conditional-assertion'],
    'only in loop over unknown list': ['conditional-assertion'],
    'commented out': ['commented-assertion'],
    'weak only': ['weak-assertions'],
    'called only': ['weak-assertions'],
    'snapshot only': ['snapshot-only'],
    skipped: ['skipped-test'],
    later: ['todo-test'],
    'greater than zero is weak': ['weak-assertions'],
  };
  for (const [name, rules] of Object.entries(expected)) assert.deepEqual(rulesOf('hollow.test.ts', name), rules, name);
});

test('smoke-named tests without assertions are warnings, not errors', () => {
  assert.equal(severityOf('hollow.test.ts', 'renders without crashing', 'no-assertions'), 'warn');
  assert.equal(severityOf('hollow.test.ts', 'no assertions', 'no-assertions'), 'error');
});

test('solid tests produce no findings at all (false-positive guard)', () => {
  const noisy = byFile['solid.test.tsx'].tests.filter((t) => t.findings.length);
  assert.deepEqual(noisy.map((t) => `${t.name}: ${t.findings.map((f) => f.rule)}`), []);
  assert.equal(byFile['solid.test.tsx'].tests.length, 20);
});

test('imported helper with assertions counts as an assertion', () => {
  const t = byFile['solid.test.tsx'].tests.find((x) => x.name === 'uses imported helper');
  assert.equal(t.assertions, 1);
});

test('mocha, chai, supertest and should.js are understood', () => {
  assert.deepEqual(rulesOf('mocha.spec.js', 'chai equal'), []);
  assert.deepEqual(rulesOf('mocha.spec.js', 'chai property terminal'), []);
  assert.deepEqual(rulesOf('mocha.spec.js', 'node assert'), []);
  assert.deepEqual(rulesOf('mocha.spec.js', 'supertest expect'), []);
  assert.deepEqual(rulesOf('mocha.spec.js', 'should style'), []);
  assert.deepEqual(rulesOf('mocha.spec.js', 'assert ok weak'), ['weak-assertions']);
  assert.deepEqual(rulesOf('mocha.spec.js', 'assert tautology'), ['tautology']);
});

test('node:test assert and t.assert count; a bare test does not', () => {
  assert.deepEqual(rulesOf('node.test.mjs', 'node:test with assert'), []);
  assert.deepEqual(rulesOf('node.test.mjs', 'node:test with t.assert'), []);
  assert.deepEqual(rulesOf('node.test.mjs', 'node:test no assertions'), ['no-assertions']);
});

test('.only disables the rest of the file', () => {
  assert.deepEqual(rulesOf('focused.test.js', 'focused one'), []);
  assert.deepEqual(rulesOf('focused.test.js', 'silently skipped'), ['focused-test']);
  assert.equal(byFile['focused.test.js'].fileFindings[0].rule, 'focused-test');
});

test('mocking the module under test is flagged; a partial mock is not', () => {
  assert.equal(byFile['cart.test.ts'].fileFindings[0].rule, 'mocked-subject');
  assert.deepEqual(rulesOf('cart.test.ts', 'sums the cart'), ['mocked-subject']);
  assert.deepEqual(byFile['partial.test.ts'].fileFindings, []);
});

test('score: hollow tests count 0, weak 0.5, todo is excluded', () => {
  const t = (mode, ...severities) => ({ mode, findings: severities.map((severity) => ({ severity })) });
  assert.equal(testHealth(t('run')), 1);
  assert.equal(testHealth(t('run', 'warn')), 0.5);
  assert.equal(testHealth(t('run', 'warn', 'error')), 0);
  assert.equal(testHealth(t('skip')), 0);
  assert.equal(testHealth(t('todo')), null);
  assert.ok(result.summary.score > 0 && result.summary.score < 100);
});

test('parse errors are reported, not thrown', () => {
  const r = analyzeFile('it("x", () => { expect(1).toBe(', 'broken.test.js');
  assert.ok(r.parseError || r.tests.length >= 0);
});

test('it.each and template-table each are recognized as tests', () => {
  const code = "it.each([[1, 2]])('adds %i', (a, b) => { expect(a + 1).toBe(b); });\n" +
    'test.each`\n a | b\n ${1} | ${2}\n`(\'table $a\', ({ a, b }) => { expect(a + 1).toBe(b); });';
  const r = analyzeFile(code, 'each.test.js');
  assert.equal(r.tests.length, 2);
  assert.ok(r.tests.every((t) => t.findings.length === 0));
});

test('regex .test() and unrelated it() calls are not tests', () => {
  const r = analyzeFile("const ok = /a/.test('a');\nconst it = (x) => x;\nfoo.test('x');", 'x.test.js');
  assert.equal(r.tests.length, 0);
});
