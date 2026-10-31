import fs from 'node:fs';
import path from 'node:path';

/** Collect the safe, mechanical fixes attached to findings, grouped by file. */
export function collectFixes(result, cwd = process.cwd()) {
  const byFile = new Map();
  const add = (file, fixes) => {
    if (!fixes?.length) return;
    const abs = path.resolve(cwd, file);
    if (!byFile.has(abs)) byFile.set(abs, []);
    byFile.get(abs).push(...fixes);
  };
  for (const f of result.files) {
    for (const x of f.fileFindings) add(f.file, x.fix);
    for (const t of f.tests) for (const x of t.findings) add(f.file, x.fix);
    if (f.file.endsWith('.py')) add(f.file, pythonFixes(path.resolve(cwd, f.file), f));
  }
  return byFile;
}

/** `assert (cond, "msg")` -> `assert cond, "msg"` on the lines hollowtest flagged. */
function pythonFixes(abs, fileResult) {
  const lines = new Set(fileResult.tests.flatMap((t) => t.findings.filter((x) => x.rule === 'tautology' && /non-empty tuple/.test(x.message)).map((x) => x.line)));
  if (!lines.size) return [];
  const code = fs.readFileSync(abs, 'utf8');
  const out = [];
  let offset = 0;
  code.split('\n').forEach((line, i) => {
    if (lines.has(i + 1)) {
      const m = /^(\s*)assert\s*\((.+),\s*((?:[rbfu]{0,2})(?:"[^"]*"|'[^']*'))\s*\)\s*$/.exec(line.replace(/\r$/, ''));
      if (m) out.push({ start: offset, end: offset + line.replace(/\r$/, '').length, text: `${m[1]}assert ${m[2].trim()}, ${m[3]}`, label: 'assert (cond, msg) -> assert cond, msg' });
    }
    offset += line.length + 1;
  });
  return out;
}

/** Apply fixes back to front; overlapping edits are skipped. Returns [{ file, applied: [labels] }]. */
export function applyFixes(byFile, { dryRun = false } = {}) {
  const report = [];
  for (const [file, fixes] of byFile) {
    const unique = [...new Map(fixes.map((f) => [`${f.start}:${f.end}:${f.text}`, f])).values()].sort((a, b) => b.start - a.start || b.end - a.end);
    let code = fs.readFileSync(file, 'utf8');
    const applied = [];
    let lastStart = Infinity;
    for (const f of unique) {
      if (f.end > lastStart) continue; // overlaps an edit already applied
      code = code.slice(0, f.start) + f.text + code.slice(f.end);
      lastStart = f.start;
      applied.push(f.label);
    }
    if (!dryRun && applied.length) fs.writeFileSync(file, code);
    if (applied.length) report.push({ file, applied: applied.reverse() });
  }
  return report;
}
