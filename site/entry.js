import { analyzeFile } from '../src/analyze.js';
import { summarize } from '../src/score.js';
import { RULE_BY_ID } from '../src/rules.js';

window.hollowtest = {
  analyze(code, filename = 'playground.test.ts') {
    const r = analyzeFile(code, filename, {});
    r.file = filename;
    return { file: r, summary: summarize([r]), rules: RULE_BY_ID };
  },
};
