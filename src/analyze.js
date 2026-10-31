import path from 'node:path';
import { parseSource, walk, memberChain, isFunction, sourceOf } from './ast.js';
import { collectAssertions, findAssertingFunctions } from './assertions.js';
import { RULES } from './rules.js';

const TEST_FNS = new Set(['it', 'test', 'specify', 'xit', 'xtest', 'fit', 'xspecify']);
const SUITE_FNS = new Set(['describe', 'context', 'suite', 'xdescribe', 'fdescribe', 'xcontext', 'xsuite']);
const MODIFIERS = new Set(['only', 'skip', 'todo', 'concurrent', 'sequential', 'each', 'failing', 'fails', 'skipIf', 'runIf', 'serial', 'cb', 'shuffle', 'fixme', 'slow', 'step', '()', '``']);
const SMOKE_NAME = /(not|n['’]t|never)\s+(throw|crash|fail|error|explode|break)|smoke|without (crash|error|throw)|renders?$|mounts?$|can be (created|instantiated|constructed)|\b(pass(es|ing)?|valid(ates)?|accepts?|allows?|succeeds?)\b|v[aá]lid[oa]s?\b|\b(aceita|permite|n[aã]o (lan[cç]a|quebra|falha))/i;

/**
 * Analyze one test file.
 * opts.resolveHelpers(file, ast) -> Set of local names bound to imported asserting helpers
 */
export function analyzeFile(code, file, opts = {}) {
  let ast;
  try {
    ast = parseSource(code, file);
  } catch (err) {
    return { file, tests: [], fileFindings: [], parseError: String(err.message || err) };
  }
  const playwright = /from\s+['"]@playwright\/test['"]|require\(['"]@playwright\/test['"]\)/.test(code);
  const local = findAssertingFunctions(ast, code);
  const imported = opts.resolveHelpers ? opts.resolveHelpers(file, ast) : { asserting: new Set(), unknown: new Set(), plain: new Set() };
  const helperNames = new Set([...local.local, ...imported.asserting]);
  const comments = ast.comments || [];

  const tests = [];
  const fileFindings = [];
  // const cases = [...] anywhere in the file: loops over these always run
  const constArrays = new Set();
  walk(ast.program, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) {
      let init = n.init;
      while (init.type === 'TSAsExpression' || init.type === 'TSSatisfiesExpression' || init.type === 'TSTypeAssertion') init = init.expression;
      if ((init.type === 'ArrayExpression' && init.elements.length) || (init.type === 'ObjectExpression' && init.properties.length)) constArrays.add(n.id.name);
    }
  });
  let hasOnly = false;
  const onlyFixes = [];

  walk(ast.program, (node, parent, ancestors) => {
    if (node.type !== 'CallExpression') return;
    const info = testCallInfo(node);
    if (!info) return;
    if (info.suite) {
      if (info.mode === 'only') { hasOnly = true; onlyFixes.push(...unfocusFix(node)); }
      return; // keep walking into the suite body
    }
    // Ignore test() calls nested inside another test's callback (subtests are analyzed as part of the parent).
    if (ancestors.some((a) => a._hollowTest)) return;
    const suiteModes = ancestors.filter((a) => a.type === 'CallExpression').map((a) => testCallInfo(a)).filter((i) => i?.suite).map((i) => i.mode);
    let mode = info.mode;
    if (mode === 'run' && suiteModes.includes('skip')) mode = 'skip';
    if (info.mode === 'only') { hasOnly = true; onlyFixes.push(...unfocusFix(node)); }
    const fn = node.arguments.find((a) => isFunction(a));
    const test = {
      name: testName(node, code),
      line: node.loc.start.line,
      endLine: node.loc.end.line,
      mode,
      inOnlySuite: suiteModes.includes('only'),
      findings: [],
      assertions: 0,
    };
    tests.push(test);
    if (!fn) {
      if (mode === 'run') mode = test.mode = node.arguments.length <= 1 ? 'todo' : 'external';
      return false;
    }
    node._hollowTest = true;
    const testParam = fn.params[0]?.type === 'Identifier' ? fn.params[0].name : null;
    const ctx = { code, file, helperNames, testParam, playwright, unknownHelpers: imported.unknown, plainNames: imported.plain };
    const assertions = collectAssertions(fn.body, ctx);
    // Mocha/Jest callback contract: handing `done` to the code under test fails the test on done(err) or timeout.
    if (testParam && /^(done|cb|callback|next|end)$/.test(testParam) && usesIdentifier(fn.body, testParam)) assertions.push({ kind: 'implicit', node: fn, matcher: testParam, ancestors: [], parent: null });
    // A generic helper declared in the test and never called exists only to be type-checked.
    if (hasTypeOnlyFunction(fn.body)) assertions.push({ kind: 'type', node: fn, matcher: 'type-check', ancestors: [], parent: null });
    // @ts-expect-error inside a test is a compile-time assertion
    for (const c of comments) if (c.start >= fn.start && c.end <= fn.end && /@ts-expect-error/.test(c.value)) assertions.push({ kind: 'type', node: c, matcher: '@ts-expect-error', ancestors: [], parent: null });
    test.assertions = assertions.filter((a) => a.kind !== 'fail').length;
    const testComments = comments.filter((c) => c.start >= fn.start && c.end <= fn.end);
    const env = { code, file, fn, test, assertions, ctx, comments: testComments, smokeName: SMOKE_NAME.test(test.name), constArrays };
    for (const rule of RULES) {
      if (!rule.check) continue;
      for (const f of rule.check(env) || []) test.findings.push({ rule: rule.id, severity: f.severity || rule.severity, line: f.line ?? test.line, message: f.message, ...(f.fix ? { fix: f.fix } : {}) });
    }
    if (test.findings.some((f) => f.rule === 'bare-expect')) test.findings = test.findings.filter((f) => f.rule !== 'no-assertions');
    if (mode === 'skip') test.findings = test.findings.filter((f) => f.rule !== 'empty-test' && f.rule !== 'no-assertions');
    if (mode === 'skip') test.findings.push({ rule: 'skipped-test', severity: 'warn', line: test.line, message: 'Test is skipped, so it verifies nothing. Agents often skip a failing test instead of fixing the code.' });
    return false; // already analyzed the body
  });

  for (const t of tests) {
    if (t.mode === 'todo') t.findings.push({ rule: 'todo-test', severity: 'info', line: t.line, message: 'Test is a placeholder (todo).' });
  }
  if (hasOnly) {
    const focusedLine = tests.find((t) => t.mode === 'only' || t.inOnlySuite)?.line ?? 1;
    fileFindings.push({ rule: 'focused-test', severity: 'error', line: focusedLine, message: '.only / fit / fdescribe left in the file: every other test in this file is silently not running.', fix: onlyFixes });
    for (const t of tests) {
      if (t.mode !== 'only' && !t.inOnlySuite && t.mode !== 'skip' && t.mode !== 'todo') {
        t.findings.push({ rule: 'focused-test', severity: 'error', line: t.line, message: 'Will not run: another test in this file uses .only.' });
      }
    }
  }
  for (const f of mockedSubjectFindings(ast, code, file)) {
    fileFindings.push(f);
    for (const t of tests) if (t.mode !== 'todo') t.findings.push({ ...f, line: t.line, message: 'Tests a mock of the module under test: ' + f.subject });
  }
  return { file, tests, fileFindings };
}

/** Recognize it()/test()/describe() calls and their modifiers. */
export function testCallInfo(node) {
  const chain = memberChain(node.callee);
  const root = chain[0];
  const isTest = TEST_FNS.has(root);
  const isSuite = SUITE_FNS.has(root);
  if (!isTest && !isSuite) return null;
  if (!chain.slice(1).every((p) => MODIFIERS.has(p))) return null;
  // it.each([...]) without the second call is not a test yet
  if (chain[chain.length - 1] === 'each' || chain[chain.length - 1] === 'skipIf' || chain[chain.length - 1] === 'runIf') return null;
  // The test call has a name (string/template/identifier) as first argument.
  const first = node.arguments[0];
  if (!first) return null;
  let mode = 'run';
  if (root.startsWith('x') || chain.includes('skip') || chain.includes('fixme')) mode = 'skip';
  else if (root === 'fit' || root === 'fdescribe' || chain.includes('only')) mode = 'only';
  else if (chain.includes('todo')) mode = 'todo';
  else if (chain.includes('skipIf') || chain.includes('runIf')) mode = 'run';
  return { suite: isSuite, mode };
}

function testName(node, code) {
  const a = node.arguments[0];
  if (!a) return '(unnamed)';
  if (a.type === 'StringLiteral') return a.value;
  if (a.type === 'TemplateLiteral') return a.quasis.map((q) => q.value.cooked).join('${…}');
  return sourceOf(code, a).slice(0, 80);
}

/**
 * foo.test.ts that does vi.mock('./foo') / jest.mock('../src/foo') with an automock or a factory
 * that never touches the real module: the test exercises the mock, not the code.
 */
function mockedSubjectFindings(ast, code, file) {
  const subject = path.basename(file).replace(/\.(test|spec|e2e|unit|int|integration)(\.[cm]?[jt]sx?)$/, '').replace(/\.[cm]?[jt]sx?$/, '');
  if (!subject || subject === 'index' || subject === file) return [];
  const findings = [];
  walk(ast.program, (node) => {
    if (node.type !== 'CallExpression') return;
    const chain = memberChain(node.callee);
    if (!((chain[0] === 'vi' || chain[0] === 'jest') && (chain[1] === 'mock' || chain[1] === 'doMock'))) return;
    const target = node.arguments[0];
    if (target?.type !== 'StringLiteral' || !target.value.startsWith('.')) return;
    const base = path.basename(target.value).replace(/\.[cm]?[jt]sx?$/, '');
    if (base !== subject) return;
    const factory = node.arguments[1];
    if (factory) {
      const src = sourceOf(code, factory);
      if (/importActual|requireActual|importOriginal|\.\.\.\s*actual|original/.test(src)) return; // partial mock: fine
    }
    findings.push({
      rule: 'mocked-subject',
      severity: 'error',
      line: node.loc.start.line,
      subject: `${chain[0]}.${chain[1]}('${target.value}')`,
      message: `${chain[0]}.${chain[1]}('${target.value}') replaces the module this file is testing; the assertions check the mock, not the real code.`,
    });
  });
  return findings;
}

/** Any use of the `done` callback: calling it, or handing it to the code under test. */
function usesIdentifier(body, name) {
  let found = false;
  walk(body, (n) => {
    if (found) return false;
    if (n.type === 'Identifier' && n.name === name) found = true;
  });
  return found;
}

function hasTypeOnlyFunction(body) {
  const declared = new Map();
  walk(body, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id && n.typeParameters) declared.set(n.id.name, n);
  });
  if (!declared.size) return false;
  const called = new Set();
  walk(body, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier') called.add(n.callee.name);
  });
  return [...declared.keys()].some((k) => !called.has(k));
}

/** it.only( -> it(, describe.only( -> describe(, fit( -> it(, fdescribe( -> describe( */
function unfocusFix(node) {
  let callee = node.callee;
  while (callee.type === 'CallExpression' || callee.type === 'TaggedTemplateExpression') callee = callee.callee || callee.tag;
  const fixes = [];
  const visit = (c) => {
    if (c.type === 'MemberExpression') {
      if (!c.computed && c.property.name === 'only') fixes.push({ start: c.object.end, end: c.property.end, text: '', label: 'remove .only' });
      visit(c.object);
    } else if (c.type === 'Identifier' && (c.name === 'fit' || c.name === 'fdescribe')) {
      fixes.push({ start: c.start, end: c.end, text: c.name === 'fit' ? 'it' : 'describe', label: `${c.name} -> ${c.name.slice(1)}` });
    }
  };
  visit(callee);
  return fixes;
}
