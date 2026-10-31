// ESLint plugin: every hollowtest rule as an ESLint rule, sharing one analysis per file.
let core;
try {
  core = await import('hollowtest');
} catch {
  core = await import('../src/index.js'); // inside the hollowtest repo
}
const { analyzeFile, makeHelperResolver, RULES } = core;

const cache = new Map();
const resolvers = new Map();

function analysis(context) {
  const filename = context.filename ?? context.getFilename();
  const text = (context.sourceCode ?? context.getSourceCode()).text;
  const key = filename;
  const hit = cache.get(key);
  if (hit && hit.text === text) return hit.result;
  const cwd = context.cwd ?? process.cwd();
  if (!resolvers.has(cwd)) resolvers.set(cwd, makeHelperResolver(cwd));
  const result = analyzeFile(text, filename, { resolveHelpers: resolvers.get(cwd) });
  cache.set(key, { text, result });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return result;
}

function makeRule(def) {
  return {
    meta: {
      type: 'problem',
      docs: { description: `${def.title}: ${def.why}`, url: `https://github.com/jeffev/hollowtest#what-it-catches` },
      schema: [],
      ...(['bare-expect', 'unawaited-assertion', 'focused-test', 'swallowed-error'].includes(def.id) ? { fixable: 'code' } : {}),
    },
    create(context) {
      return {
        'Program:exit'() {
          const r = analysis(context);
          const seen = new Set();
          const report = (x, testName) => {
            const k = `${x.line}:${x.message}`;
            if (seen.has(k)) return;
            seen.add(k);
            const fix = x.fix?.length ? (fixer) => x.fix.map((f) => fixer.replaceTextRange([f.start, f.end], f.text)) : undefined;
            context.report({ loc: { line: x.line, column: 0 }, message: (testName ? `"${testName}": ` : '') + x.message, fix });
          };
          for (const x of r.fileFindings) if (x.rule === def.id) report(x);
          for (const t of r.tests) for (const x of t.findings) {
            if (x.rule !== def.id) continue;
            if (x.rule === 'mocked-subject' || (x.rule === 'focused-test' && x.message.startsWith('Will not run'))) continue;
            report(x, t.name);
          }
        },
      };
    },
  };
}

const rules = Object.fromEntries(RULES.map((r) => [r.id, makeRule(r)]));
const level = { error: 'error', warn: 'warn', info: 'off' };

const plugin = {
  meta: { name: 'eslint-plugin-hollowtest', version: '0.1.0' },
  rules,
  configs: {},
};

plugin.configs.recommended = {
  name: 'hollowtest/recommended',
  files: ['**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}', '**/__tests__/**/*.{js,jsx,ts,tsx,mjs,cjs}'],
  plugins: { hollowtest: plugin },
  rules: Object.fromEntries(RULES.map((r) => [`hollowtest/${r.id}`, level[r.severity]])),
};

export default plugin;
