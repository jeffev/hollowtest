#!/usr/bin/env node
// Claude Code PostToolUse hook: after the agent writes or edits a test file, check it with hollowtest.
// Hollow tests (error severity) are reported on stderr with exit code 2, which Claude Code feeds back
// to the agent so it fixes them before moving on. Anything else exits 0 silently.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { analyzeProject, isTestFile } = await import(pathToFileURL(path.join(root, 'src', 'index.js')).href);

let input = '';
for await (const chunk of process.stdin) input += chunk;
let event;
try { event = JSON.parse(input || '{}'); } catch { process.exit(0); }

const file = event.tool_input?.file_path || event.tool_input?.path;
if (!file || process.env.HOLLOWTEST_HOOK === 'off') process.exit(0);
const cwd = event.cwd || process.cwd();
const abs = path.resolve(cwd, file);
if (!fs.existsSync(abs) || !isTestFile(abs)) process.exit(0);

try { process.chdir(cwd); } catch {}
const result = analyzeProject([abs], { cwd });
const problems = [];
for (const f of result.files) {
  for (const x of f.fileFindings) if (x.severity === 'error') problems.push(`- line ${x.line} [${x.rule}] ${x.message}`);
  for (const t of f.tests) {
    for (const x of t.findings) {
      if (x.severity !== 'error' || x.rule === 'mocked-subject' || (x.rule === 'focused-test' && x.message.startsWith('Will not run'))) continue;
      problems.push(`- line ${x.line} "${t.name}" [${x.rule}] ${x.message}`);
    }
  }
}
if (!problems.length) process.exit(0);

const rel = path.relative(cwd, abs).replace(/\\/g, '/');
process.stderr.write(
  `hollowtest: ${problems.length} hollow test problem(s) in ${rel}. These tests would pass even if the code were broken:\n` +
  problems.slice(0, 20).join('\n') +
  (problems.length > 20 ? `\n- … ${problems.length - 20} more` : '') +
  '\nFix them so each test fails when the behavior it names breaks (see the hollowtest skill). ' +
  'Do not delete or skip the tests to silence this. If a finding is wrong, say so to the user.\n'
);
process.exit(2);
