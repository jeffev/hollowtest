const HEALTH = { error: 0, warn: 0.5, info: 0.9 };

/** Per-test health: worst finding wins. Todo placeholders are not counted. */
export function testHealth(t) {
  if (t.mode === 'todo' || t.mode === 'external') return null;
  if (t.mode === 'skip') return 0;
  let h = 1;
  for (const f of t.findings) h = Math.min(h, HEALTH[f.severity] ?? 1);
  return h;
}

export function summarize(files) {
  const counted = files.flatMap((f) => f.tests).map(testHealth).filter((h) => h !== null);
  const total = counted.length;
  const score = total ? Math.round((100 * counted.reduce((a, b) => a + b, 0)) / total) : null;
  const byRule = {};
  let hollow = 0, weak = 0, healthy = 0;
  for (const f of files) {
    for (const t of f.tests) {
      const h = testHealth(t);
      if (h === null) continue;
      if (h === 0) hollow++; else if (h < 1) weak++; else healthy++;
      for (const r of new Set(t.findings.map((x) => x.rule))) byRule[r] = (byRule[r] || 0) + 1;
    }
  }
  return { score, grade: grade(score), tests: total, hollow, weak, healthy, files: files.length, byRule, parseErrors: files.filter((f) => f.parseError).length };
}

export function grade(score) {
  if (score === null) return '-';
  if (score >= 95) return 'A';
  if (score >= 85) return 'B';
  if (score >= 70) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

