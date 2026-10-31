import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeProject, findPython } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const skip = findPython() ? false : 'no Python 3.8+ on this machine';
const run = () => {
  const r = analyzeProject([path.join(here, 'sample-py')], { cwd: here });
  return Object.fromEntries(r.files.map((f) => [path.basename(f.file), f]));
};

test('python: every hollow pattern is flagged with the expected rule', { skip }, () => {
  const byFile = run();
  const rules = Object.fromEntries(byFile['test_hollow.py'].tests.map((t) => [t.name, t.findings.map((f) => f.rule).sort()]));
  assert.deepEqual(rules, {
    test_empty_body: ['empty-test'],
    test_no_assertions: ['no-assertions'],
    test_tuple_assert: ['tautology'],
    test_compares_with_itself: ['tautology'],
    test_assert_true_literal: ['tautology'],
    test_expects_raise_in_except: ['swallowed-error'],
    test_except_exception_swallows_assertion: ['swallowed-error'],
    test_only_conditional: ['conditional-assertion'],
    test_commented_out: ['commented-assertion'],
    test_weak_only: ['weak-assertions'],
    test_called_only: ['weak-assertions'],
    test_skipped: ['skipped-test'],
    test_xfail: ['skipped-test'],
    test_len_greater_than_zero: ['weak-assertions'],
  });
});

test('python: solid tests (pytest + unittest + helpers) produce no errors', { skip }, () => {
  const byFile = run();
  const noisy = byFile['test_solid.py'].tests.filter((t) => t.findings.some((f) => f.severity !== 'warn' || f.rule !== 'no-assertions'));
  assert.deepEqual(noisy.map((t) => t.name), []);
  const smoke = byFile['test_solid.py'].tests.find((t) => t.name === 'test_does_not_raise_for_valid_input');
  assert.equal(smoke.findings[0].severity, 'warn');
});

test('python: patching the function under test is flagged', { skip }, () => {
  const byFile = run();
  assert.equal(byFile['test_cart.py'].fileFindings[0].rule, 'mocked-subject');
});
