import { walk, memberChain, isFunction, sourceOf } from './ast.js';
import { CHAI_TERMINALS } from './assertions.js';

const CALLBACK_SINKS = new Set(['then', 'catch', 'finally', 'setTimeout', 'setInterval', 'setImmediate', 'nextTick', 'queueMicrotask', 'on', 'once', 'addEventListener', 'addListener', 'subscribe', 'requestAnimationFrame']);
const LOOP_CALLBACKS = new Set(['forEach', 'map', 'filter', 'some', 'every', 'flatMap', 'reduce', 'find']);
const GUARD = /\bexpect\s*\.\s*(assertions|hasAssertions)\s*\(|\b\w+\s*\.\s*plan\s*\(/;

const line = (n) => n.loc?.start.line;
const real = (assertions) => assertions.filter((a) => a.kind !== 'fail');

/**
 * Each rule documents itself; `check(env)` returns findings for one test case.
 * env: { code, file, fn, test, assertions, ctx, comments, smokeName }
 */
export const RULES = [
  {
    id: 'empty-test',
    severity: 'error',
    title: 'Empty test',
    why: 'A test with an empty body always passes.',
    check({ fn }) {
      if (fn.body.type === 'BlockStatement' && fn.body.body.length === 0) return [{ message: 'Test body is empty: it always passes.' }];
    },
  },
  {
    id: 'no-assertions',
    severity: 'error',
    title: 'No assertions',
    why: 'Without an assertion a test only proves the code did not throw. Agents write these to turn a coverage number green.',
    check({ fn, assertions, smokeName, ctx, code }) {
      if (fn.body.type === 'BlockStatement' && fn.body.body.length === 0) return;
      if (real(assertions).length > 0) return;
      if (assertions.some((a) => a.kind === 'fail')) return; // try { x() ; fail() } style
      const unknown = calledUnknownHelpers(fn, ctx.unknownHelpers);
      if (unknown.length) return [{ severity: 'warn', message: `No assertions found. It calls ${unknown.map((u) => u + '()').join(', ')}, which hollowtest could not inspect; make sure it asserts.` }];
      if (smokeName) return [{ severity: 'warn', message: 'No assertions: this is a smoke test that only checks nothing throws. Assert on the output too.' }];
      return [{ message: 'No assertions: this test passes as long as nothing throws.' }];
    },
  },
  {
    id: 'bare-expect',
    severity: 'error',
    title: 'expect() without a matcher',
    why: '`expect(x)` or `expect(x).toBeTruthy` (missing parentheses) checks nothing.',
    check({ fn }) {
      const out = [];
      walk(fn.body, (node) => {
        if (node.type !== 'ExpressionStatement') return;
        let e = node.expression;
        if (e.type === 'AwaitExpression') e = e.argument;
        if (!e) return;
        const chain = memberChain(e.type === 'CallExpression' ? e.callee : e);
        if (chain[0] !== 'expect') return;
        if (e.type === 'CallExpression' && (chain.length === 1 || (chain.length === 2 && (chain[1] === 'soft' || chain[1] === 'poll')))) {
          out.push({ line: line(node), message: '`expect(...)` is never followed by a matcher, so it asserts nothing.' });
        } else if (e.type === 'MemberExpression' && !CHAI_TERMINALS.has(chain[chain.length - 1])) {
          out.push({ line: line(node), message: `\`.${chain[chain.length - 1]}\` is referenced but never called: add \`()\`.` });
        }
      });
      return out;
    },
  },
  {
    id: 'tautology',
    severity: 'error',
    title: 'Assertion that cannot fail',
    why: '`expect(x).toBe(x)` or `expect(true).toBe(true)` passes no matter what the code does.',
    check({ assertions, code }) {
      // A placeholder `expect(true).toBe(true)` next to real checks is noise, not a hollow test.
      const others = real(assertions).some((a) => !a.tautology);
      return assertions.filter((a) => a.tautology).map((a) => ({
        line: line(a.node),
        severity: others ? 'warn' : 'error',
        message: a.tautology === 'same'
          ? `Compares a value with itself: \`${clip(sourceOf(code, a.node))}\`.`
          : `Asserts on a constant, so it can never fail: \`${clip(sourceOf(code, a.node))}\`.`,
      }));
    },
  },
  {
    id: 'swallowed-error',
    severity: 'error',
    title: 'Errors swallowed by try/catch',
    why: 'Expecting a throw inside `catch` passes when nothing is thrown; asserting inside `try` with a silent `catch` hides failing assertions.',
    check({ fn, assertions, code }) {
      const out = [];
      const guarded = GUARD.test(sourceOf(code, fn));
      walk(fn.body, (node) => {
        if (node.type !== 'TryStatement' || !node.handler) return;
        const inBlock = assertions.filter((a) => a.ancestors.includes(node.block));
        const inCatch = assertions.filter((a) => a.ancestors.includes(node.handler));
        const blockThrows = containsThrow(node.block);
        const catchRethrows = containsThrow(node.handler.body) || /\b(done|reject|fail)\s*\(/.test(sourceOf(code, node.handler.body));
        if (inCatch.length && !inBlock.length && !blockThrows && !guarded && !flagCheckedAfter(node, assertions)) {
          out.push({ line: line(node), message: 'The assertions live in `catch`; if the code stops throwing, this test still passes. Use `expect(() => ...).toThrow()` / `await expect(p).rejects...`, or add `expect.assertions(n)`.' });
        } else if (inBlock.length && !inCatch.length && !catchRethrows) {
          out.push({ line: line(node), message: 'Assertions inside `try` are caught by a `catch` that does not rethrow: a failing assertion is silently ignored.' });
        }
      });
      return out;
    },
  },
  {
    id: 'unawaited-assertion',
    severity: 'error',
    title: 'Async assertion the test never waits for',
    why: 'An un-awaited `.resolves`/`.rejects`/Playwright assertion, or an expect inside `.then()`/`setTimeout` the test does not wait for, runs after the test already passed.',
    check({ fn, assertions }) {
      const out = [];
      const usesDone = fn.params.length > 0 && fn.params[0].type === 'Identifier' && /^(done|cb|callback|next|end)$/.test(fn.params[0].name);
      for (const a of real(assertions)) {
        if (a.kind === 'type') continue; // checked by the compiler, not at runtime
        if (a.isAsync && isFloating(a.node, a.parent)) {
          out.push({ line: line(a.node), message: `\`${a.matcher}\` is asynchronous but not awaited or returned: the test finishes before it runs.` });
          continue;
        }
        if (usesDone) continue;
        const sink = floatingCallbackSink(a);
        // Timers and events usually fire while a later `await` is pending; promise callbacks don't get that pass.
        if (sink && !/^(then|catch|finally)$/.test(sink) && fn.async && awaitsAfter(fn.body, a.node.end)) continue;
        if (sink) out.push({ line: line(a.node), message: `Assertion runs inside a \`${sink}\` callback the test never waits for; await the promise or return it.` });
      }
      return dedupe(out);
    },
  },
  {
    id: 'conditional-assertion',
    severity: 'warn',
    title: 'Assertions that may never run',
    why: 'If every assertion sits behind an `if` or inside a loop, the test passes when the branch is skipped or the list is empty.',
    check({ assertions, constArrays }) {
      if (assertions.some((a) => a.kind === 'type')) return; // compile-time checks run regardless of the branch
      const rs = real(assertions).filter((a) => a.matcher !== 'throw' && !a.ancestors.some((n) => n.type === 'CatchClause'));
      if (!rs.length) return;
      const reasons = rs.map((a) => conditionalReason(a, constArrays));
      if (reasons.every(Boolean)) {
        return [{ line: line(rs[0].node), message: `Every assertion is ${reasons[0]}; when that never happens, the test passes without checking anything.` }];
      }
    },
  },
  {
    id: 'commented-assertion',
    severity: 'warn',
    title: 'Commented-out assertion',
    why: 'Commenting out the failing `expect` is the classic way to make a red test green.',
    check({ comments }) {
      const hits = comments.filter((c) => c.value.split('\n').some((l) => /^\s*(\/\/\s*)?(await\s+)?(expect|assert|t\.(is|equal|deepEqual|true|false))\s*[.(]/.test(l)));
      if (hits.length) return [{ line: line(hits[0]), message: `${hits.length} assertion${hits.length > 1 ? 's are' : ' is'} commented out.` }];
    },
  },
  {
    id: 'weak-assertions',
    severity: 'warn',
    title: 'Only weak assertions',
    why: '`toBeDefined()`, `toBeTruthy()`, `not.toBeNull()` and a bare `toHaveBeenCalled()` pass for almost any result.',
    check({ assertions, smokeName }) {
      const rs = real(assertions).filter((a) => !a.tautology);
      if (!rs.length) return;
      if (smokeName && rs.every((a) => /throw|reject/i.test(a.matcher))) return; // "does not throw" is the spec
      if (rs.every((a) => a.kind === 'weak' || a.kind === 'call')) {
        const names = [...new Set(rs.map((a) => (a.negated ? 'not.' : '') + a.matcher))].slice(0, 4).join(', ');
        return [{ line: line(rs[0].node), message: `Only weak checks (${names}): almost any result passes. Assert on the actual value.` }];
      }
    },
  },
  {
    id: 'snapshot-only',
    severity: 'info',
    title: 'Snapshot is the only check',
    why: 'Snapshots get regenerated with `-u` the moment they fail, by people and agents alike.',
    check({ assertions }) {
      const rs = real(assertions);
      if (rs.length && rs.every((a) => a.kind === 'snapshot')) return [{ line: line(rs[0].node), message: 'The only assertion is a snapshot; it gets regenerated instead of read when it fails.' }];
    },
  },
  { id: 'mocked-subject', severity: 'error', title: 'Mocks the module under test', why: '`foo.test.ts` that mocks `./foo` asserts against the mock. Agents do this to make a failing test pass.' },
  { id: 'focused-test', severity: 'error', title: '.only left in', why: '`.only` silently disables every other test in the file.' },
  { id: 'skipped-test', severity: 'warn', title: 'Skipped test', why: 'A skipped test checks nothing. Agents skip tests they cannot make pass.' },
  { id: 'todo-test', severity: 'info', title: 'Todo placeholder', why: 'A placeholder, not a test. Not counted in the score.' },
];

export const RULE_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]));

function clip(s) {
  s = s.replace(/\s+/g, ' ');
  return s.length > 70 ? s.slice(0, 67) + '...' : s;
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => (seen.has(f.line + f.message) ? false : seen.add(f.line + f.message)));
}

/**
 * `catch (e) { threw = true }` / `catch (e) { error = e }` followed by an assertion on that variable
 * after the try: the test does fail when nothing throws.
 */
function flagCheckedAfter(tryNode, assertions) {
  const touched = new Set();
  walk(tryNode.handler.body, (n) => {
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') touched.add(n.left.name);
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.type === 'Identifier' && /^(push|add|set|unshift)$/.test(n.callee.property.name)) touched.add(n.callee.object.name);
  });
  if (!touched.size) return false;
  return assertions.some((a) => {
    if (a.node.start < tryNode.end) return false;
    let hit = false;
    walk(a.node, (x) => { if (x.type === 'Identifier' && touched.has(x.name)) hit = true; });
    return hit;
  });
}

function awaitsAfter(body, pos) {
  let found = false;
  walk(body, (n) => {
    if (found) return false;
    if ((n.type === 'AwaitExpression' || (n.type === 'ForOfStatement' && n.await)) && n.start > pos) found = true;
  });
  return found;
}

function containsThrow(node) {
  let found = false;
  walk(node, (n) => {
    if (found) return false;
    if (isFunction(n) && n !== node) return false;
    if (n.type === 'ThrowStatement') found = true;
    if (n.type === 'CallExpression') {
      const c = memberChain(n.callee).join('.');
      if (/^(fail|assert\.fail|expect\.(fail|unreachable)|t\.fail)$/.test(c)) found = true;
    }
  });
  return found;
}

/** The async assertion's value is dropped: a bare statement or `void`. */
function isFloating(node, parent) {
  if (!parent) return false;
  if (parent.type === 'ExpressionStatement') return true;
  if (parent.type === 'UnaryExpression' && parent.operator === 'void') return true;
  return false;
}

/** If the assertion sits in a callback (then/setTimeout/on) whose promise or event is not awaited, name the sink. */
function floatingCallbackSink(a) {
  const anc = a.ancestors;
  for (let i = anc.length - 1; i > 0; i--) {
    const fnNode = anc[i];
    if (!isFunction(fnNode)) continue;
    const call = anc[i - 1];
    if (call?.type !== 'CallExpression' || !call.arguments.includes(fnNode)) return null;
    const chain = memberChain(call.callee);
    const sink = chain[chain.length - 1];
    if (!CALLBACK_SINKS.has(sink)) continue; // e.g. forEach/map: synchronous, keep climbing
    // Climb the rest of the chain (.then().catch()) and see what consumes it.
    for (let j = i - 2; j >= 0; j--) {
      const n = anc[j];
      if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression' || n.type === 'CallExpression' || n.type === 'OptionalCallExpression') continue;
      if (n.type === 'ExpressionStatement') {
        // awaited or returned somewhere above? (await new Promise(r => setTimeout(() => {...; r()})))
        const outer = anc.slice(0, j);
        if (outer.some((o) => o.type === 'AwaitExpression' || o.type === 'ReturnStatement' || o.type === 'NewExpression' || o.type === 'YieldExpression')) return null;
        return sink;
      }
      return null; // awaited, returned, assigned, passed along
    }
    return null;
  }
  return null;
}

function conditionalReason(a, constArrays = new Set()) {
  const nonEmpty = (n) => isNonEmptyLiteral(n) || (n?.type === 'Identifier' && constArrays.has(n.name)) || isObjectKeysOfConst(n, constArrays);
  for (let i = a.ancestors.length - 1; i >= 0; i--) {
    const n = a.ancestors[i];
    const child = a.ancestors[i + 1] || a.node;
    if (n.type === 'IfStatement' && child !== n.test) return 'inside an `if`';
    if (n.type === 'ConditionalExpression' && child !== n.test) return 'inside a ternary';
    if (n.type === 'LogicalExpression' && child === n.right) return 'behind `&&`/`||`';
    if (n.type === 'SwitchCase') return 'inside a `switch` case';
    if ((n.type === 'ForOfStatement' || n.type === 'ForInStatement') && child === n.body && !nonEmpty(n.right)) return 'inside a loop';
    if ((n.type === 'WhileStatement' || n.type === 'ForStatement' || n.type === 'DoWhileStatement') && child === n.body && n.type !== 'DoWhileStatement') return 'inside a loop';
    if (isFunction(n)) {
      const call = a.ancestors[i - 1];
      if (call?.type === 'CallExpression' && call.arguments.includes(n)) {
        const chain = memberChain(call.callee);
        if (LOOP_CALLBACKS.has(chain[chain.length - 1])) {
          const target = call.callee.object;
          if (target && nonEmpty(target)) return null;
          return 'inside a `.' + chain[chain.length - 1] + '()` callback';
        }
      }
    }
  }
  return null;
}

function isObjectKeysOfConst(n, constArrays) {
  if (n?.type !== 'CallExpression') return false;
  const c = memberChain(n.callee).join('.');
  return /^Object\.(keys|values|entries)$/.test(c) && n.arguments[0] && (isNonEmptyLiteral(n.arguments[0]) || (n.arguments[0].type === 'Identifier' && constArrays.has(n.arguments[0].name)));
}

function isNonEmptyLiteral(n) {
  while (n && (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'TSTypeAssertion' || n.type === 'ParenthesizedExpression')) n = n.expression;
  return n && ((n.type === 'ArrayExpression' && n.elements.length > 0) || (n.type === 'StringLiteral' && n.value.length > 0) || (n.type === 'ObjectExpression' && n.properties.length > 0));
}

function calledUnknownHelpers(fn, unknown) {
  if (!unknown || !unknown.size) return [];
  const names = new Set();
  walk(fn.body, (n) => {
    if (n.type === 'CallExpression') {
      const chain = memberChain(n.callee);
      if (unknown.has(chain[0])) names.add(chain.length > 1 && chain[1] !== '()' ? chain.slice(0, 2).join('.') : chain[0]);
    }
  });
  return [...names];
}
