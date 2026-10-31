#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyzeProject, changedTestFiles } from '../src/index.js';
import { formatText, formatGithub, toJSON } from '../src/report.js';
import { RULES } from '../src/rules.js';

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

const HELP = `hollowtest ${pkg.version}: find tests that test nothing

Usage
  npx hollowtest [paths...] [options]

Options
  --format <text|json|github>  Output format (default: text; github when GITHUB_ACTIONS is set)
  --json                       Shorthand for --format json
  --min-score <n>              Exit 1 if the integrity score is below n (0-100)
  --fail-on <error|warn>       Exit 1 if any finding at this severity or worse exists
  --include <regex>            Regex for test file paths (default: *.test.* / *.spec.* / __tests__)
  --fix                        Apply the safe mechanical fixes (missing (), await, .only, expect.assertions,
                               Python tuple asserts), then report what is left
  --dry-run                    With --fix: show what would change without writing
  --badge                      Print a README badge (Markdown) with the score and grade
  --changed                    Only test files changed in the working tree (git)
  --base <ref>                 With --changed: also files changed since <ref>, e.g. origin/main
  --verbose                    Also show info-level findings
  --mutate                     Mutation check: break the code and see if any test notices
  --test-cmd <cmd>             Command for --mutate ({files} = related test files)
  --max-mutants <n>            Mutants per run for --mutate (default: 30)
  --install-skill              Add the hollowtest skill to .claude/skills (Claude Code) and print the
                               AGENTS.md snippet for Codex, Cursor and others
  --rules                      List the rules and exit
  -v, --version                Print version
  -h, --help                   Show this help

Examples
  npx hollowtest                     scan the current project
  npx hollowtest src --min-score 90  fail CI below 90
  npx hollowtest --mutate src/cart   do the tests catch a broken cart?
`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      format: { type: 'string' },
      json: { type: 'boolean' },
      'min-score': { type: 'string' },
      'fail-on': { type: 'string' },
      include: { type: 'string' },
      verbose: { type: 'boolean' },
      mutate: { type: 'boolean' },
      'test-cmd': { type: 'string' },
      'max-mutants': { type: 'string' },
      seed: { type: 'string' },
      changed: { type: 'boolean' },
      fix: { type: 'boolean' },
      badge: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      base: { type: 'string' },
      rules: { type: 'boolean' },
      'install-skill': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (err) {
  console.error(err.message + '\n\n' + HELP);
  process.exit(2);
}
const o = args.values;
if (o.help) { console.log(HELP); process.exit(0); }
if (o.version) { console.log(pkg.version); process.exit(0); }
if (o.rules) {
  for (const r of RULES) console.log(`${r.severity.padEnd(6)} ${r.id.padEnd(22)} ${r.why}`);
  process.exit(0);
}

if (o['install-skill']) {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'hollowtest', 'SKILL.md');
  const destDir = path.join(process.cwd(), '.claude', 'skills', 'hollowtest');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, 'SKILL.md'));
  console.log(`Installed ${path.relative(process.cwd(), path.join(destDir, 'SKILL.md'))} (Claude Code picks it up automatically).\n`);
  console.log('For Codex, Cursor, Copilot and other agents, add this to AGENTS.md:\n');
  console.log(`## Tests
- Every test must fail if the behavior it names is broken. Assert on actual values, not toBeDefined()/toBeTruthy().
- Never make a failing test pass by skipping it, commenting out or weakening assertions, mocking the module under test, or copying actual output into the expected value. Fix the code or ask.
- After writing or changing tests, run \`npx hollowtest <paths>\` and fix every error. For important logic, run \`npx hollowtest --mutate <source file>\` and kill the survivors.`);
  process.exit(0);
}

let inputs = args.positionals.length ? args.positionals : ['.'];
if (o.changed || o.base) {
  try {
    inputs = changedTestFiles(o.base);
  } catch (err) {
    console.error(`hollowtest: --changed needs a git repository (${err.message})`);
    process.exit(2);
  }
  if (!inputs.length) { console.log('hollowtest: no changed test files.'); process.exit(0); }
}
for (const p of inputs) {
  if (!fs.existsSync(p)) { console.error(`hollowtest: path not found: ${p}`); process.exit(2); }
}

if (o.mutate) {
  const { runMutation } = await import('../src/mutate.js');
  const code = await runMutation(inputs, { testCmd: o['test-cmd'], maxMutants: Number(o['max-mutants'] || 30), seed: o.seed, json: o.json || o.format === 'json', include: o.include });
  process.exit(code);
}

let result = analyzeProject(inputs, { include: o.include });
if (o.fix) {
  const { collectFixes, applyFixes } = await import('../src/fix.js');
  const report = applyFixes(collectFixes(result), { dryRun: o['dry-run'] });
  const total = report.reduce((n, r) => n + r.applied.length, 0);
  for (const r of report) console.log(`${o['dry-run'] ? 'would fix' : 'fixed'}  ${path.relative(process.cwd(), r.file).split(path.sep).join('/')}: ${r.applied.join(', ')}`);
  console.log(total ? `
${o['dry-run'] ? 'Would apply' : 'Applied'} ${total} fix(es) in ${report.length} file(s).` : 'Nothing hollowtest can fix automatically.');
  if (!o['dry-run'] && total) result = analyzeProject(inputs, { include: o.include });
}
if (o.badge) {
  const s = result.summary;
  const color = { A: 'brightgreen', B: 'green', C: 'yellow', D: 'orange', F: 'red' }[s.grade] || 'lightgrey';
  const label = s.score === null ? 'no tests' : `${s.score}/100 ${s.grade}`;
  console.log(`[![test integrity: ${label}](https://img.shields.io/badge/test_integrity-${encodeURIComponent(label).replace(/-/g, '--')}-${color})](https://github.com/jeffev/hollowtest)`);
  process.exit(0);
}
const format = o.json ? 'json' : o.format || (process.env.GITHUB_ACTIONS ? 'github' : 'text');
if (format === 'json') console.log(toJSON(result));
else if (format === 'github') { console.log(formatGithub(result)); console.log(formatText(result, { verbose: o.verbose })); }
else console.log(formatText(result, { verbose: o.verbose }));

let exit = 0;
const s = result.summary;
if (o['min-score'] !== undefined && s.score !== null && s.score < Number(o['min-score'])) {
  if (format !== 'json') console.error(`\nhollowtest: score ${s.score} is below --min-score ${o['min-score']}`);
  exit = 1;
}
if (o['fail-on']) {
  const levels = o['fail-on'] === 'warn' ? ['error', 'warn'] : ['error'];
  const hit = result.files.some((f) => f.fileFindings.some((x) => levels.includes(x.severity)) || f.tests.some((t) => t.findings.some((x) => levels.includes(x.severity))));
  if (hit) exit = 1;
}
process.exit(exit);
