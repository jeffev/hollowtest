import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSource, walk } from './ast.js';
import { fileURLToPath } from 'node:url';
import { discoverTestFiles, resolveImport, findPython } from './index.js';

const JOURNAL = '.hollowtest-restore.json';
// Swapped in for the mutated expression of a survivor: if the tests still pass, nothing runs that code.
const PROBE = {
  js: "(() => { throw new Error('hollowtest probe') })()",
  py: "(_ for _ in ()).throw(RuntimeError('hollowtest probe'))",
};
const PY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'mutate_py.py');
const isPy = (f) => f.endsWith('.py');
const FLIP = { '===': '!==', '!==': '===', '==': '!=', '!=': '==', '<': '<=', '<=': '<', '>': '>=', '>=': '>', '+': '-', '-': '+', '*': '/', '/': '*', '&&': '||', '||': '&&', '??': '&&' };
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = c('31'), green = c('32'), yellow = c('33'), dim = c('2'), bold = c('1'), cyan = c('36');

/** Small seeded PRNG so a run is reproducible (--seed). */
function rng(seed) {
  let s = [...String(seed)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 2166136261);
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Enumerate mutation candidates in one source file. Each is a text splice. */
export function findMutants(code, file) {
  let ast;
  try { ast = parseSource(code, file); } catch { return []; }
  const lines = code.split('\n');
  const out = [];
  const add = (node, start, end, replacement, label, probe = node) => {
    const lineNo = code.slice(0, start).split('\n').length;
    if (/hollowtest-ignore|istanbul ignore|c8 ignore/.test(lines[lineNo - 1] || '') || /^\s*(\/\/|\/\*|\*).*hollowtest-ignore/.test(lines[lineNo - 2] || '')) return;
    out.push({ file, start, end, replacement, original: code.slice(start, end), line: lineNo, label, probeStart: probe.start, probeEnd: probe.end });
  };
  walk(ast.program, (node, parent) => {
    if (node.type.startsWith('TS') && node.type !== 'TSAsExpression' && node.type !== 'TSNonNullExpression' && node.type !== 'TSSatisfiesExpression') return false;
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') return false;
    if (node.type === 'CallExpression') {
      const callee = code.slice(node.callee.start, node.callee.end);
      if (/^(console|logger|log|debug|assert|invariant|warning)\b/.test(callee)) return false;
    }
    if ((node.type === 'BinaryExpression' || node.type === 'LogicalExpression') && FLIP[node.operator]) {
      // String concatenation: `+` on a string literal or template is noise, skip it.
      if (node.operator === '+' && [node.left, node.right].some((n) => n.type === 'StringLiteral' || n.type === 'TemplateLiteral')) return;
      const between = code.slice(node.left.end, node.right.start);
      const idx = between.indexOf(node.operator);
      if (idx >= 0) {
        const start = node.left.end + idx;
        add(node, start, start + node.operator.length, FLIP[node.operator], `${node.operator} → ${FLIP[node.operator]}`);
      }
    } else if (node.type === 'UnaryExpression' && node.operator === '!' && parent?.type !== 'UnaryExpression') {
      add(node, node.start, node.argument.start, '', 'remove !');
    } else if (node.type === 'BooleanLiteral') {
      add(node, node.start, node.end, String(!node.value), `${node.value} → ${!node.value}`);
    } else if (node.type === 'IfStatement') {
      add(node, node.test.start, node.test.end, node.alternate ? 'false' : 'true', node.alternate ? 'if (…) → if (false)' : 'if (…) → if (true)', node.test);
    } else if (node.type === 'ConditionalExpression') {
      add(node, node.test.start, node.test.end, 'false', 'ternary → always else', node.test);
    } else if (node.type === 'ReturnStatement' && node.argument && !['Identifier', 'NullLiteral'].includes(node.argument.type) && !(node.argument.type === 'Identifier' && node.argument.name === 'undefined')) {
      add(node, node.argument.start, node.argument.end, 'null', 'return … → return null', node.argument);
    } else if (node.type === 'NumericLiteral' && parent?.type !== 'MemberExpression' && parent?.type !== 'ObjectProperty' && node.value !== 0) {
      add(node, node.start, node.end, String(node.value + 1), `${node.value} → ${node.value + 1}`);
    }
  });
  return out;
}

function detectRunner(cwd) {
  let dir = path.resolve(cwd);
  while (true) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest) return 'npx vitest run --reporter=dot {files}';
      if (deps.jest) return 'npx jest --silent {files}';
      if (deps.mocha) return 'npx mocha {files}';
      if (deps.ava) return 'npx ava {files}';
      return 'node --test {files}';
    }
    const up = path.dirname(dir);
    if (up === dir) return 'node --test {files}';
    dir = up;
  }
}

function runTests(cmdTemplate, files, timeoutMs, cwd) {
  const quoted = files.map((f) => JSON.stringify(path.relative(cwd, f).replace(/\\/g, '/'))).join(' ');
  const cmd = cmdTemplate.includes('{files}') ? cmdTemplate.replace('{files}', quoted) : cmdTemplate;
  const t0 = Date.now();
  // NODE_TEST_CONTEXT leaks in when hollowtest itself runs under `node --test` and makes a nested run report success.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const r = spawnSync(cmd, { cwd, shell: true, timeout: timeoutMs, encoding: 'utf8', env: { ...env, CI: '1', FORCE_COLOR: '0', PYTHONDONTWRITEBYTECODE: '1' } });
  return { ok: r.status === 0, timedOut: r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM', ms: Date.now() - t0, output: (r.stdout || '') + (r.stderr || '') };
}

function restoreFromJournal(cwd) {
  const j = path.join(cwd, JOURNAL);
  if (!fs.existsSync(j)) return 0;
  const saved = JSON.parse(fs.readFileSync(j, 'utf8'));
  for (const [file, content] of Object.entries(saved)) fs.writeFileSync(file, content);
  fs.unlinkSync(j);
  return Object.keys(saved).length;
}

/** Ask the stdlib-only Python helper for the import map or for mutants. */
function callPython(py, request) {
  const r = spawnSync(py.cmd, [...py.args, '-I', PY_SCRIPT], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('Python mutation helper failed: ' + (r.stderr || '').slice(-2000));
  return JSON.parse(r.stdout);
}

/** pytest when it is installed, otherwise unittest (both take test file paths). */
export function detectPyRunner(cwd, py) {
  const exe = [/\s/.test(py.cmd) ? JSON.stringify(py.cmd) : py.cmd, ...py.args].join(' ');
  const hasPytest = spawnSync(py.cmd, [...py.args, '-c', 'import pytest'], { cwd, encoding: 'utf8' }).status === 0;
  return hasPytest ? `${exe} -m pytest -q -x -p no:cacheprovider {files}` : `${exe} -m unittest {files}`;
}

/** Map each JS/TS source file to the test files that import it. */
function mapJsTests(tests, testSet, testsBySource) {
  for (const t of tests) {
    let ast;
    try { ast = parseSource(fs.readFileSync(t, 'utf8'), t); } catch { continue; }
    walk(ast.program, (n) => {
      let spec = null;
      if (n.type === 'ImportDeclaration' && n.importKind !== 'type') spec = n.source.value;
      else if (n.type === 'CallExpression' && (n.callee.name === 'require' || n.callee.type === 'Import') && n.arguments[0]?.type === 'StringLiteral') spec = n.arguments[0].value;
      if (!spec) return;
      const target = resolveImport(t, spec);
      if (!target || testSet.has(target) || /node_modules/.test(target)) return;
      if (!testsBySource.has(target)) testsBySource.set(target, new Set());
      testsBySource.get(target).add(t);
    });
  }
}

/**
 * Mutation check: for each mutant, rewrite the source file, run only the tests that import it,
 * and restore the file. A mutant that survives is a behavior change no test notices. Each survivor
 * then gets a probe (its expression replaced by one that throws): if the tests still pass, no test
 * runs that code at all, and the survivor is reported as unreached instead.
 */
export async function runMutation(inputs, opts = {}) {
  const cwd = process.cwd();
  const restored = restoreFromJournal(cwd);
  if (restored) console.error(yellow(`Restored ${restored} file(s) from an interrupted previous run.`));
  const log = (...a) => { if (!opts.json) console.log(...a); };

  const tests = discoverTestFiles(['.'], { include: opts.include });
  const testSet = new Set(tests);
  const testsBySource = new Map();
  mapJsTests(tests.filter((t) => !isPy(t)), testSet, testsBySource);

  const pyTests = tests.filter(isPy);
  let py = null;
  if (pyTests.length) {
    py = findPython();
    if (py) {
      const { testsBySource: pyMap } = callPython(py, { cmd: 'map', tests: pyTests, cwd });
      for (const [src, ts] of Object.entries(pyMap)) testsBySource.set(path.resolve(src), new Set(ts.map((t) => path.resolve(t))));
    }
  }

  const wanted = inputs.map((p) => path.resolve(p));
  const sources = [...testsBySource.keys()].filter((s) => wanted.some((w) => s === w || s.startsWith(w + path.sep)) && !/(\.|_|-)(test|spec)\./.test(s));
  if (!sources.length) {
    const pyHint = pyTests.length && !py ? '\nPython 3.8+ was not found (set HOLLOWTEST_PYTHON to point at it).' : '';
    console.log(yellow('No source files imported by tests under: ' + inputs.join(', ')) + dim('\nPass a source path that your tests import, e.g. `npx hollowtest --mutate src/cart.ts` or `--mutate app/cart.py`.' + pyHint));
    return 2;
  }

  const langOf = (f) => (isPy(f) ? 'py' : 'js');
  const langs = [...new Set(sources.map(langOf))];
  const cmds = {};
  for (const l of langs) cmds[l] = opts.testCmd || (l === 'py' ? detectPyRunner(cwd, py) : detectRunner(cwd));
  const relatedTests = (l) => [...new Set(sources.filter((s) => langOf(s) === l).flatMap((s) => [...testsBySource.get(s)]))];
  const runnerText = langs.map((l) => cmds[l]).join(' | ');
  log(`${bold('hollowtest --mutate')}  ${dim(`${sources.length} source file(s), ${langs.reduce((n, l) => n + relatedTests(l).length, 0)} test file(s), runner: ${runnerText}`)}`);

  const timeouts = {};
  for (const l of langs) {
    const baseline = runTests(cmds[l], relatedTests(l), 300_000, cwd);
    if (!baseline.ok) {
      console.error(red('The tests fail before any mutation, so the check cannot run. Output:\n') + baseline.output.slice(-3000));
      return 2;
    }
    // A runner that finds no tests exits 0 on some versions, and every mutant would "survive".
    if (/\bRan 0 tests\b|\bno tests ran\b|\bcollected 0 items\b|\b0 passing\b/i.test(baseline.output)) {
      console.error(red(`The test runner found no tests (${cmds[l]}). Pass --test-cmd with a command that runs them. Output:\n`) + baseline.output.slice(-1500));
      return 2;
    }
    timeouts[l] = Math.max(10_000, baseline.ms * 3);
  }

  const random = rng(opts.seed ?? 'hollowtest');
  const all = [];
  for (const s of sources.filter((f) => !isPy(f))) all.push(...findMutants(fs.readFileSync(s, 'utf8'), s));
  const pySources = sources.filter(isPy);
  if (pySources.length) {
    const { mutants } = callPython(py, { cmd: 'mutants', files: pySources });
    for (const [file, list] of Object.entries(mutants)) all.push(...list.map((m) => ({ ...m, file: path.resolve(file) })));
  }
  // Shuffle deterministically, then take a spread across files.
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  const picked = all.slice(0, opts.maxMutants || 30);

  const originals = new Map(sources.map((s) => [s, fs.readFileSync(s, 'utf8')]));
  fs.writeFileSync(path.join(cwd, JOURNAL), JSON.stringify(Object.fromEntries(originals)));
  const restoreAll = () => { for (const [f, content] of originals) fs.writeFileSync(f, content); try { fs.unlinkSync(path.join(cwd, JOURNAL)); } catch {} };
  const onSignal = () => { restoreAll(); process.exit(130); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const trySplice = (file, start, end, text) => {
    const src = originals.get(file);
    fs.writeFileSync(file, src.slice(0, start) + text + src.slice(end));
    const l = langOf(file);
    const r = runTests(cmds[l], [...testsBySource.get(file)], timeouts[l], cwd);
    fs.writeFileSync(file, src);
    return r;
  };

  const results = [];
  let probes = 0;
  try {
    for (const [i, m] of picked.entries()) {
      const r = trySplice(m.file, m.start, m.end, m.replacement);
      const status = r.timedOut ? 'timeout' : r.ok ? 'survived' : 'killed';
      results.push({ ...m, status });
      if (!opts.json) process.stdout.write(status === 'survived' ? red('S') : status === 'timeout' ? yellow('T') : green('.'));
      if (!opts.json && (i + 1) % 50 === 0) process.stdout.write('\n');
    }
    if (opts.probe !== false) {
      // One probe per distinct expression: several survivors often share one.
      const byProbe = new Map();
      for (const r of results) {
        if (r.status !== 'survived' || r.probeStart == null) continue;
        const key = `${r.file}:${r.probeStart}:${r.probeEnd}`;
        if (!byProbe.has(key)) byProbe.set(key, []);
        byProbe.get(key).push(r);
      }
      for (const group of byProbe.values()) {
        const { file, probeStart, probeEnd } = group[0];
        const r = trySplice(file, probeStart, probeEnd, PROBE[langOf(file)]);
        probes++;
        if (r.ok) for (const m of group) m.status = 'unreached';
      }
    }
  } finally {
    restoreAll();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  const originalsByRel = new Map();
  for (const r of results) {
    const rel = path.relative(cwd, r.file).replace(/\\/g, '/');
    originalsByRel.set(rel, originals.get(r.file));
    r.file = rel;
  }
  const killed = results.filter((r) => r.status === 'killed' || r.status === 'timeout').length;
  const unreached = results.filter((r) => r.status === 'unreached').length;
  const score = results.length ? Math.round((100 * killed) / results.length) : null;
  if (opts.json) {
    console.log(JSON.stringify({ score, mutants: results.length, killed, survived: results.length - killed, unreached, runner: runnerText, results: results.map(({ start, end, probeStart, probeEnd, ...r }) => r) }, null, 2));
    return 0;
  }
  console.log('\n');
  const order = (a, b) => a.file.localeCompare(b.file) || a.line - b.line;
  const show = (list, tag) => {
    for (const s of list) {
      const lineText = originalsByRel.get(s.file).split(/\r?\n/)[s.line - 1].trim();
      console.log(`  ${tag}  ${dim(`${s.file}:${s.line}`)}  ${bold(s.label)}`);
      console.log(`             ${dim(lineText.slice(0, 110))}`);
    }
  };
  const survivors = results.filter((r) => r.status === 'survived').sort(order);
  const notRun = results.filter((r) => r.status === 'unreached').sort(order);
  show(survivors, red('survived '));
  show(notRun, yellow('unreached'));
  const slipped = results.length - killed;
  const colorFor = score >= 80 ? green : score >= 60 ? yellow : red;
  const split = unreached ? ` (${survivors.length} in code the tests run, ${unreached} in code no test runs)` : '';
  console.log(`\n${bold('Mutation score')}  ${colorFor(bold(`${score}%`))}  ${dim(`${killed} of ${results.length} breaking changes caught by a test, ${slipped} slipped through${split}`)}`);
  if (survivors.length) console.log(dim('survived: the tests run this code but no assertion notices the change. Add an assertion that would fail for it.'));
  if (notRun.length) console.log(dim('unreached: no test runs this code at all (or an error there is swallowed). Cover it first; assertions come after.'));
  console.log(dim(`Sampled ${results.length} of ${all.length} possible mutants (seed ${opts.seed ?? 'hollowtest'})${probes ? `, plus ${probes} reachability probe(s)` : ''}. Use --max-mutants for more.`));
  return 0;
}
