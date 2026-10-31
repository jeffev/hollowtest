import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSource, walk } from './ast.js';
import { discoverTestFiles, resolveImport } from './index.js';

const JOURNAL = '.hollowtest-restore.json';
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
  const add = (node, start, end, replacement, label) => {
    const lineNo = code.slice(0, start).split('\n').length;
    if (/hollowtest-ignore|istanbul ignore|c8 ignore/.test(lines[lineNo - 1] || '') || /^\s*(\/\/|\/\*|\*).*hollowtest-ignore/.test(lines[lineNo - 2] || '')) return;
    out.push({ file, start, end, replacement, original: code.slice(start, end), line: lineNo, label });
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
      add(node, node.test.start, node.test.end, node.alternate ? 'false' : 'true', node.alternate ? 'if (…) → if (false)' : 'if (…) → if (true)');
    } else if (node.type === 'ConditionalExpression') {
      add(node, node.test.start, node.test.end, 'false', 'ternary → always else');
    } else if (node.type === 'ReturnStatement' && node.argument && !['Identifier', 'NullLiteral'].includes(node.argument.type) && !(node.argument.type === 'Identifier' && node.argument.name === 'undefined')) {
      add(node, node.argument.start, node.argument.end, 'null', 'return … → return null');
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
  const r = spawnSync(cmd, { cwd, shell: true, timeout: timeoutMs, encoding: 'utf8', env: { ...env, CI: '1', FORCE_COLOR: '0' } });
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

/**
 * Mutation check: for each mutant, rewrite the source file, run only the tests that import it,
 * and restore the file. A mutant that survives is a behavior change no test notices.
 */
export async function runMutation(inputs, opts = {}) {
  const cwd = process.cwd();
  const restored = restoreFromJournal(cwd);
  if (restored) console.error(yellow(`Restored ${restored} file(s) from an interrupted previous run.`));

  // Map each source file to the test files that import it.
  const tests = discoverTestFiles(['.'], { include: opts.include });
  const testSet = new Set(tests);
  const testsBySource = new Map();
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
  const wanted = inputs.map((p) => path.resolve(p));
  const sources = [...testsBySource.keys()].filter((s) => wanted.some((w) => s === w || s.startsWith(w + path.sep)) && !/(\.|_|-)(test|spec)\./.test(s));
  if (!sources.length) {
    console.log(yellow('No source files imported by tests under: ' + inputs.join(', ')) + dim('\nPass a source path that your tests import, e.g. `npx hollowtest --mutate src/cart.ts`.'));
    return 2;
  }

  const cmd = opts.testCmd || detectRunner(cwd);
  const relatedTests = [...new Set(sources.flatMap((s) => [...testsBySource.get(s)]))];
  if (!opts.json) console.log(`${bold('hollowtest --mutate')}  ${dim(`${sources.length} source file(s), ${relatedTests.length} test file(s), runner: ${cmd}`)}`);
  const baseline = runTests(cmd, relatedTests, 300_000, cwd);
  if (!baseline.ok) {
    console.error(red('The tests fail before any mutation, so the check cannot run. Output:\n') + baseline.output.slice(-3000));
    return 2;
  }
  const timeoutMs = Math.max(10_000, baseline.ms * 3);

  const random = rng(opts.seed ?? 'hollowtest');
  const all = [];
  for (const s of sources) all.push(...findMutants(fs.readFileSync(s, 'utf8'), s));
  // Shuffle deterministically, then take a spread across files.
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  const picked = all.slice(0, opts.maxMutants || 30);

  const originals = new Map(sources.map((s) => [s, fs.readFileSync(s, 'utf8')]));
  fs.writeFileSync(path.join(cwd, JOURNAL), JSON.stringify(Object.fromEntries(originals)));
  const restoreAll = () => { for (const [f, content] of originals) fs.writeFileSync(f, content); try { fs.unlinkSync(path.join(cwd, JOURNAL)); } catch {} };
  const onSignal = () => { restoreAll(); process.exit(130); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const results = [];
  try {
    for (const [i, m] of picked.entries()) {
      const src = originals.get(m.file);
      fs.writeFileSync(m.file, src.slice(0, m.start) + m.replacement + src.slice(m.end));
      const r = runTests(cmd, [...testsBySource.get(m.file)], timeoutMs, cwd);
      fs.writeFileSync(m.file, src);
      const status = r.timedOut ? 'timeout' : r.ok ? 'survived' : 'killed';
      results.push({ ...m, status, file: path.relative(cwd, m.file).replace(/\\/g, '/') });
      if (!opts.json) process.stdout.write(status === 'survived' ? red('S') : status === 'timeout' ? yellow('T') : green('.'));
      if (!opts.json && (i + 1) % 50 === 0) process.stdout.write('\n');
    }
  } finally {
    restoreAll();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  const killed = results.filter((r) => r.status !== 'survived').length;
  const score = results.length ? Math.round((100 * killed) / results.length) : null;
  if (opts.json) {
    console.log(JSON.stringify({ score, mutants: results.length, killed, survived: results.length - killed, runner: cmd, results: results.map(({ start, end, ...r }) => r) }, null, 2));
    return 0;
  }
  console.log('\n');
  const survivors = results.filter((r) => r.status === 'survived').sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const s of survivors) {
    const lineText = originals.get(path.resolve(cwd, s.file)).split('\n')[s.line - 1].trim();
    console.log(`  ${red('survived')}  ${dim(`${s.file}:${s.line}`)}  ${bold(s.label)}`);
    console.log(`            ${dim(lineText.slice(0, 110))}`);
  }
  const colorFor = score >= 80 ? green : score >= 60 ? yellow : red;
  console.log(`\n${bold('Mutation score')}  ${colorFor(bold(`${score}%`))}  ${dim(`${killed} of ${results.length} breaking changes caught by a test, ${survivors.length} slipped through`)}`);
  if (survivors.length) console.log(dim('Each survivor is a change to the code that no test noticed. Add an assertion that would fail for it.'));
  console.log(dim(`Sampled ${results.length} of ${all.length} possible mutants (seed ${opts.seed ?? 'hollowtest'}). Use --max-mutants for more.`));
  return 0;
}
