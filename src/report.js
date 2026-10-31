import { testHealth } from './index.js';
import { RULE_BY_ID } from './rules.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = c('31'), yellow = c('33'), green = c('32'), dim = c('2'), bold = c('1'), cyan = c('36');
const SEV = { error: red('error'), warn: yellow('warn '), info: dim('info ') };

export function formatText(result, { verbose = false, maxPerFile = 50 } = {}) {
  const { files, summary } = result;
  const lines = [];
  for (const f of files) {
    const entries = [];
    if (f.parseError) entries.push(`  ${red('parse')}  ${dim(f.parseError)}`);
    for (const ff of f.fileFindings) entries.push(`  ${SEV[ff.severity]}  ${dim(`${f.file}:${ff.line}`)}  ${ff.message}  ${dim(ff.rule)}`);
    for (const t of f.tests) {
      const shown = t.findings.filter((x) => verbose || x.severity !== 'info');
      // file-level findings already reported once
      for (const x of shown) {
        if (x.rule === 'mocked-subject' || (x.rule === 'focused-test' && x.message.startsWith('Will not run'))) continue;
        entries.push(`  ${SEV[x.severity]}  ${dim(`${f.file}:${x.line}`)}  ${bold(clip(t.name, 60))}  ${x.message}  ${dim(x.rule)}`);
      }
      const notRunning = t.findings.find((x) => x.rule === 'focused-test' && x.message.startsWith('Will not run'));
      if (notRunning && verbose) entries.push(`  ${SEV.error}  ${dim(`${f.file}:${t.line}`)}  ${bold(clip(t.name, 60))}  ${notRunning.message}  ${dim('focused-test')}`);
    }
    if (!entries.length) continue;
    lines.push('', cyan(f.file));
    lines.push(...entries.slice(0, maxPerFile));
    if (entries.length > maxPerFile) lines.push(dim(`  … ${entries.length - maxPerFile} more (use --json for everything)`));
  }
  lines.push('', formatSummary(summary));
  return lines.join('\n');
}

export function formatSummary(s) {
  if (!s.tests) return yellow('No test cases found. Pass a path, e.g. `npx hollowtest src`.');
  const colorFor = s.score >= 85 ? green : s.score >= 70 ? yellow : red;
  const out = [];
  out.push(`${bold('Test integrity')}  ${colorFor(bold(`${s.score}/100`))}  ${dim('grade')} ${colorFor(bold(s.grade))}`);
  out.push(`${s.tests} tests in ${s.files} files  ·  ${red(s.hollow + ' hollow')}  ·  ${yellow(s.weak + ' weak')}  ·  ${green(s.healthy + ' solid')}`);
  const rules = Object.entries(s.byRule).sort((a, b) => b[1] - a[1]);
  if (rules.length) {
    out.push('');
    for (const [id, n] of rules) {
      const r = RULE_BY_ID[id];
      out.push(`  ${String(n).padStart(5)}  ${(r?.title || id).padEnd(42)} ${dim(id)}`);
    }
  }
  if (s.parseErrors) out.push(dim(`  (${s.parseErrors} files could not be parsed)`));
  if (s.pythonMissing) out.push(yellow(`  ${s.pythonMissing} Python test file(s) skipped: no Python 3.8+ found (set HOLLOWTEST_PYTHON).`));
  return out.join('\n');
}

/** GitHub Actions workflow commands: findings show up inline on the PR diff. */
export function formatGithub(result) {
  const lines = [];
  for (const f of result.files) {
    for (const ff of f.fileFindings) lines.push(annotation(ff, f.file, ff.line));
    for (const t of f.tests) for (const x of t.findings) {
      if (x.severity === 'info' || x.rule === 'mocked-subject' || (x.rule === 'focused-test' && x.message.startsWith('Will not run'))) continue;
      lines.push(annotation(x, f.file, x.line, t.name));
    }
  }
  const s = result.summary;
  lines.push(`::notice title=hollowtest::Test integrity ${s.score}/100 (${s.grade}) · ${s.hollow} hollow, ${s.weak} weak, ${s.healthy} solid of ${s.tests} tests`);
  return lines.join('\n');
}

function annotation(x, file, line, testName) {
  const level = x.severity === 'error' ? 'error' : 'warning';
  const msg = (testName ? `"${testName}": ` : '') + x.message;
  return `::${level} file=${file},line=${line},title=hollowtest ${x.rule}::${esc(msg)}`;
}

const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export function toJSON(result) {
  return JSON.stringify({
    summary: result.summary,
    files: result.files.map((f) => ({
      file: f.file,
      parseError: f.parseError,
      fileFindings: f.fileFindings.map(({ subject, ...rest }) => rest),
      tests: f.tests.map((t) => ({ name: t.name, line: t.line, mode: t.mode, assertions: t.assertions, health: testHealth(t), findings: t.findings })),
    })),
  }, null, 2);
}

function clip(s, n) {
  s = s.replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
