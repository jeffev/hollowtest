import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeFile } from './analyze.js';
import { parseSource } from './ast.js';
import { findAssertingFunctions } from './assertions.js';

export { analyzeFile } from './analyze.js';
export { RULES, RULE_BY_ID } from './rules.js';
export { testHealth, summarize, grade } from './score.js';
import { summarize } from './score.js';

const NAMED_TEST = /(\.|_|-)(test|spec)(-d)?\.[cm]?[jt]sx?$/;
// foo.test.ts, foo.spec.js, test.ts (date-fns style), and anything in test/ tests/ __tests__/ spec/ (mocha, ava)
const TEST_FILE = /(\.|_|-)(test|spec)(-d)?\.[cm]?[jt]sx?$|(^|\/)(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests?|specs?)\/.+\.[cm]?[jt]sx?$/;
// Inside test folders: fixtures and helpers are not test files unless named like one.
const NOT_TESTS = /(^|\/)(__fixtures__|fixtures?|__mocks__|__snapshots__|mocks?|support|helpers?|utils?|types?|benchmarks?|bench|examples?|stubs?|data)\//;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', 'out', '.turbo', '.cache', 'vendor', '.svelte-kit', '.output', 'tmp', '.yarn', 'bower_components']);
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const FRAMEWORK_PKG = /^(vitest|@jest\/globals|jest|mocha|chai|node:test|node:assert|assert|ava|tap|uvu|@playwright\/test|bun:test|sinon|react|vue|svelte|@testing-library\/.*|msw|supertest|nock)(\/|$)/;
const MAX_BYTES = 1_500_000;
// pytest defaults (test_*.py, *_test.py) and Django's tests.py
const PY_TEST = /(^|\/)(test_[^/]*|[^/]*_test|tests)\.py$/;
const PY_IGNORED = new Set(['venv', '__pycache__', 'site-packages', '.tox', 'env', '.venv', 'migrations']);

/** Find test files under the given paths (files are taken as-is). */
export function discoverTestFiles(inputs, { include } = {}) {
  const out = new Set();
  const re = include ? new RegExp(include) : TEST_FILE;
  const visit = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isFile()) { out.add(path.resolve(p)); return; }
    if (!st.isDirectory()) return;
    for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
      if (ent.isDirectory() && (ent.name.startsWith('.') || IGNORED_DIRS.has(ent.name) || PY_IGNORED.has(ent.name))) continue;
      if (ent.isDirectory() && fs.existsSync(path.join(p, ent.name, 'pyvenv.cfg'))) continue; // any virtualenv
      const full = path.join(p, ent.name);
      if (ent.isDirectory()) visit(full);
      else {
        const rel = path.relative(root, full).replace(/\\/g, '/');
        if (rel.endsWith('.py')) {
          if ((include ? re : PY_TEST).test(rel) && (include || !/(^|\/)(bench|benchmarks?|examples?|docs?_src)\//.test(rel))) out.add(path.resolve(full));
          continue;
        }
        if (!re.test(rel) || full.endsWith('.d.ts')) continue;
        if (!include && NOT_TESTS.test(rel) && !NAMED_TEST.test(rel)) continue;
        out.add(path.resolve(full));
      }
    }
  };
  let root;
  for (const i of inputs) {
    try { root = fs.statSync(i).isDirectory() ? i : path.dirname(i); } catch { continue; }
    visit(i);
  }
  return [...out].sort();
}

/** Is this path a test file by the default conventions? (Used by the agent hook and --changed.) */
export function isTestFile(file) {
  const p = file.replace(/\\/g, '/');
  if (p.endsWith('.d.ts') || /\/node_modules\//.test(p)) return false;
  if (NAMED_TEST.test(p) || PY_TEST.test(p)) return true;
  if (p.endsWith('.py')) return false;
  return TEST_FILE.test(p) && !NOT_TESTS.test(p);
}

/** Test files changed in the working tree (and since `base`, if given), via git. */
export function changedTestFiles(base, cwd = process.cwd()) {
  const run = (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  };
  const top = run(['rev-parse', '--show-toplevel'])[0];
  const names = new Set([...run(['diff', '--name-only', 'HEAD']), ...run(['ls-files', '--others', '--exclude-standard'])]);
  if (base) for (const n of run(['diff', '--name-only', `${base}...HEAD`])) names.add(n);
  return [...names].map((n) => path.resolve(top, n)).filter((f) => fs.existsSync(f) && isTestFile(f));
}

export function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => path.join(base, 'index' + e))];
  // TS ESM style: import './x.js' that points to x.ts
  if (/\.(m|c)?js$/.test(base)) candidates.push(...EXTS.map((e) => base.replace(/\.(m|c)?js$/, e)));
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

/** Build a resolver that finds imported helper functions containing assertions (one level deep). */
export function makeHelperResolver(root = '') {
  const cache = new Map();
  const exportedAsserting = (file) => {
    if (cache.has(file)) return cache.get(file);
    let result = null;
    try {
      const code = fs.readFileSync(file, 'utf8');
      // Only test helpers get the `if (...) throw` heuristic: in source code that is input validation.
      if (code.length < MAX_BYTES) result = findAssertingFunctions(parseSource(code, file), code, { allowThrow: looksLikeHelperPath(file, root) }).exported;
    } catch {}
    cache.set(file, result);
    return result;
  };
  return (file, ast) => {
    const asserting = new Set();
    const unknown = new Set();
    const plain = new Set(); // imported from code we inspected and found no assertions in
    for (const stmt of ast.program.body) {
      let spec, bindings = [];
      if (stmt.type === 'ImportDeclaration') {
        if (stmt.importKind === 'type') continue;
        spec = stmt.source.value;
        for (const s of stmt.specifiers) {
          if (s.type === 'ImportSpecifier') bindings.push({ local: s.local.name, imported: s.imported.name ?? s.imported.value });
          else if (s.type === 'ImportDefaultSpecifier') bindings.push({ local: s.local.name, imported: 'default' });
          else if (s.type === 'ImportNamespaceSpecifier') bindings.push({ local: s.local.name, imported: '*' });
        }
      } else if (stmt.type === 'VariableDeclaration') {
        for (const d of stmt.declarations) {
          const init = d.init;
          if (init?.type === 'CallExpression' && init.callee.name === 'require' && init.arguments[0]?.type === 'StringLiteral') {
            spec = init.arguments[0].value;
            if (d.id.type === 'ObjectPattern') for (const p of d.id.properties) { if (p.type === 'ObjectProperty' && p.value.type === 'Identifier') bindings.push({ local: p.value.name, imported: p.key.name ?? p.key.value }); }
            else if (d.id.type === 'Identifier') bindings.push({ local: d.id.name, imported: '*' });
          }
        }
      }
      if (!spec || !bindings.length || FRAMEWORK_PKG.test(spec)) continue;
      const target = resolveImport(file, spec);
      if (target) {
        const exp = exportedAsserting(target);
        if (!exp) { if (looksLikeHelperPath(spec)) bindings.forEach((b) => unknown.add(b.local)); continue; }
        for (const b of bindings) {
          if (b.imported === '*') for (const e of exp) asserting.add(`${b.local}.${e}`);
          else if (exp.has(b.imported)) asserting.add(b.local);
          else plain.add(b.local);
        }
      } else if (spec.startsWith('.') || /^(@\/|~\/|#|@@\/|src\/)/.test(spec) || looksLikeHelperPath(spec)) {
        bindings.forEach((b) => unknown.add(b.local));
      }
    }
    return { asserting, unknown, plain };
  };
}

const HELPER_NAME = /(test|spec|helper|fixture|support|assert|expect|matcher|verify)/i;
const TEST_DIR = /^(tests?|__tests__|specs?|e2e|fixtures?|__fixtures__|__helpers__|test-?utils|testing|support|__mocks__)$/i;

/**
 * A test helper: named like one (test-utils.ts, assertions.ts) or living under a test folder.
 * lib/helpers/ alone is application code (axios), and a repo called `my-tests` proves nothing.
 */
function looksLikeHelperPath(p, root = '') {
  const norm = (x) => x.replace(/\\/g, '/');
  const rel = root && norm(p).startsWith(norm(root)) ? norm(p).slice(norm(root).length) : norm(p);
  const parts = rel.split('/').filter((x) => x && x !== '.' && x !== '..');
  const base = parts.pop() || '';
  if (/^(index|main)\.[cm]?[jt]sx?$/.test(base) && parts.length) return TEST_DIR.test(parts[parts.length - 1]) || HELPER_NAME.test(parts[parts.length - 1]);
  return HELPER_NAME.test(base.replace(/\.[cm]?[jt]sx?$/, '')) || parts.slice(-3).some((d) => TEST_DIR.test(d));
}

/** Analyze every test file under `inputs`. */
export function analyzeProject(inputs, opts = {}) {
  const files = discoverTestFiles(inputs, opts);
  const resolveHelpers = makeHelperResolver(path.resolve(inputs[0] && fs.existsSync(inputs[0]) && fs.statSync(inputs[0]).isDirectory() ? inputs[0] : '.'));
  const results = [];
  const rel = (file) => path.relative(opts.cwd || process.cwd(), file).replace(/\\/g, '/') || file;
  const pyFiles = files.filter((f) => f.endsWith('.py'));
  for (const file of files) {
    if (file.endsWith('.py')) continue;
    let code;
    try { code = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (code.length > MAX_BYTES) continue;
    const r = analyzeFile(code, file, { resolveHelpers });
    r.file = rel(file);
    if (r.tests.length || r.parseError) results.push(r);
  }
  let pythonMissing = 0;
  if (pyFiles.length) {
    const py = analyzePython(pyFiles, opts.cwd || process.cwd());
    if (!py) pythonMissing = pyFiles.length;
    else for (const r of py) { r.file = rel(r.file); if (r.tests.length || r.parseError) results.push(r); }
  }
  results.sort((a, b) => a.file.localeCompare(b.file));
  const summary = summarize(results);
  if (pythonMissing) summary.pythonMissing = pythonMissing;
  return { files: results, summary };
}

let pythonCmd;
/** A Python 3 interpreter: $HOLLOWTEST_PYTHON, python3, python, or the Windows launcher. */
export function findPython() {
  if (pythonCmd !== undefined) return pythonCmd;
  const candidates = [process.env.HOLLOWTEST_PYTHON, 'python3', 'python', 'py'].filter(Boolean);
  pythonCmd = null;
  for (const c of candidates) {
    const args = c === 'py' ? ['-3'] : [];
    const r = spawnSync(c, [...args, '-c', 'import sys; print(sys.version_info[0] * 100 + sys.version_info[1])'], { encoding: 'utf8' });
    if (r.status === 0 && Number(r.stdout.trim()) >= 308) { pythonCmd = { cmd: c, args }; break; }
  }
  return pythonCmd;
}

/** Run the stdlib-only Python analyzer on pytest/unittest files. Returns null if no Python 3.8+ is available. */
export function analyzePython(files, cwd = process.cwd()) {
  const py = findPython();
  if (!py) return null;
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'hollow_py.py');
  const r = spawnSync(py.cmd, [...py.args, '-I', script], { input: JSON.stringify({ files, cwd }), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('Python analyzer failed: ' + (r.stderr || '').slice(-2000));
  return JSON.parse(r.stdout);
}
