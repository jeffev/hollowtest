import { walk, memberChain, isFunction, isLiteral, normalized } from './ast.js';

/** Matchers that pass for almost any value: they prove the code ran, not that it is right. */
export const WEAK_MATCHERS = new Set([
  'toBeDefined', 'toBeTruthy', 'toBeFalsy', 'toBeInstanceOf', 'toBeTypeOf', 'toBeObject', 'toBeArray',
  'toBeFunction', 'toBeString', 'toBeNumber', 'toBeBoolean', 'toBeDate',
  // chai
  'exist', 'ok', 'a', 'an',
]);
/** `toBeInstanceOf(BadRequestException)` says something; `toBeInstanceOf(Object)` does not. */
const GENERIC_CLASSES = new Set(['Object', 'Array', 'Function', 'Promise', 'Error', 'Map', 'Set', 'String', 'Number', 'Boolean', 'Date', 'Observable', 'EventEmitter']);
const INSTANCE_MATCHERS = new Set(['toBeInstanceOf', 'instanceof', 'instanceOf']);
/** Matchers that are weak only when negated: `not.toBeNull()` is "anything but null". */
export const WEAK_WHEN_NEGATED = new Set(['toBeNull', 'toBeUndefined', 'toThrow', 'toThrowError', 'null', 'undefined', 'throw', 'throws']);
/** Interaction matchers that only check that a call happened at all. */
export const CALL_ONLY_MATCHERS = new Set(['toHaveBeenCalled', 'toBeCalled', 'called', 'calledOnce', 'toHaveBeenCalledOnce']);
export const SNAPSHOT_MATCHERS = new Set(['toMatchSnapshot', 'toMatchInlineSnapshot', 'toMatchFileSnapshot', 'toThrowErrorMatchingSnapshot', 'toThrowErrorMatchingInlineSnapshot', 'snapshot', 'matchSnapshot']);
export const EQUALITY_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual', 'equal', 'equals', 'eq', 'eql', 'deepEqual', 'strictEqual', 'deepStrictEqual', 'is', 'same', 'strictSame', 'looseEqual', 'notEqual', 'notStrictEqual', 'notDeepEqual', 'not']);
/** Chai-style assertions written as property access, e.g. `expect(x).to.be.true`. */
export const CHAI_TERMINALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'ok', 'exist', 'empty', 'extensible', 'sealed', 'frozen', 'finite', 'called', 'calledOnce', 'calledTwice', 'notCalled']);
/** Explicit failure calls: their presence makes a try/catch-expects-throw test sound. */
export const FAIL_CALLS = [/^fail$/, /^assert\.fail$/, /^expect\.(fail|unreachable)$/, /^t\.fail$/, /^chai\.assert\.fail$/];
/** Playwright web-first assertions are async and must be awaited. */
export const PLAYWRIGHT_ASYNC = new Set(['toBeAttached', 'toBeChecked', 'toBeDisabled', 'toBeEditable', 'toBeEmpty', 'toBeEnabled', 'toBeFocused', 'toBeHidden', 'toBeInViewport', 'toBeVisible', 'toContainText', 'toHaveAccessibleDescription', 'toHaveAccessibleName', 'toHaveAttribute', 'toHaveClass', 'toHaveCount', 'toHaveCSS', 'toHaveId', 'toHaveJSProperty', 'toHaveRole', 'toHaveScreenshot', 'toHaveText', 'toHaveTitle', 'toHaveURL', 'toHaveValue', 'toHaveValues', 'toPass', 'toBeOK']);

/** Assertion methods on the test context object (node:test `t.assert.*`, ava `t.is`, tap `t.same`). */
const T_ASSERT = new Set(['is', 'not', 'deepEqual', 'notDeepEqual', 'equal', 'equals', 'notEqual', 'strictEqual', 'notStrictEqual', 'deepStrictEqual', 'notDeepStrictEqual', 'ok', 'notOk', 'true', 'false', 'truthy', 'falsy', 'throws', 'throwsAsync', 'notThrows', 'notThrowsAsync', 'rejects', 'resolves', 'resolveMatch', 'doesNotThrow', 'doesNotReject', 'match', 'notMatch', 'regex', 'notRegex', 'same', 'notSame', 'strictSame', 'strictNotSame', 'has', 'hasStrict', 'notHas', 'type', 'error', 'ifError', 'like', 'unlike', 'snapshot', 'matchSnapshot', 'assert', 'expect', 'fail', 'pass', 'equalValues', 'deepEqualValues']);
const TYPE_ASSERT = /^(Expect|ExpectTrue|ExpectFalse|Assert|AssertTrue|AssertFalse|AssertEqual|IsExact|Equal|Equals|IsEqual|ExpectEqual|IsTrue|TypeEqual|ExpectType|IsIdentical)$/;
const CUSTOM_HELPER = /^(expect|assert|verify|check|ensure|should|validate|must)([A-Z_0-9].*)?$/;
const IMPLICIT_QUERY = /^(getBy|getAllBy|findBy|findAllBy)[A-Z]/;

/**
 * Classify a CallExpression (or a chai-style property assertion) as an assertion, or return null.
 * ctx: { code, testParam, helperNames:Set, playwright:boolean }
 */
export function classifyCall(node, ctx) {
  const chain = memberChain(node.callee);
  const root = chain[0];
  const last = chain[chain.length - 1];
  const joined = chain.join('.');

  // expect(...)...matcher(...) and expect.soft(...)/expect.poll(...)
  if (root === 'expect' && chain.length >= 3 && chain.includes('()') && last !== '()') {
    return describeExpect(node, chain, ctx);
  }
  if ((root === 'expectTypeOf' || root === 'assertType') && last !== '()') return { kind: 'type', node, matcher: last };
  // util.assertEqual<A, B>(true), expectType<T>(x): compile-time checks via generics
  if (node.typeParameters || node.typeArguments) {
    if (/^(assert|expect)/i.test(last)) return { kind: 'type', node, matcher: last };
  }

  if (root === 'assert' || (root === 'chai' && chain[1] === 'assert')) {
    const method = root === 'assert' ? (chain.length === 1 ? 'assert' : last) : last;
    if (method === 'fail') return { kind: 'fail', node, matcher: method };
    return describeAssertCall(node, method, ctx);
  }
  if (/^(sinon|td|testdouble)$/.test(root) && (chain.includes('assert') || chain.includes('verify'))) return { kind: 'strong', node, matcher: last };

  // node:test / ava / tap: t.is(), t.deepEqual(), t.assert.equal()
  // Only for a conventionally named context param: `input.match()` in app code is not `t.match()`.
  if (ctx.testParam && root === ctx.testParam && /^(t|tt|test|ctx|context|assert|a)$/.test(root) && chain.length >= 2) {
    const method = chain[1] === 'assert' ? last : chain[1];
    if (method === 'fail') return { kind: 'fail', node, matcher: method };
    if (T_ASSERT.has(method)) return describeAssertCall(node, method, ctx);
  }

  // fail('should have thrown'), jest/jasmine global
  if (FAIL_CALLS.some((re) => re.test(joined))) return { kind: 'fail', node, matcher: joined };

  // anything.should.x(), request(app).get('/').expect(200), cy.get(x).should('be.visible')
  if (chain.includes('should') || (chain.length > 1 && (last === 'expect' || last === 'should' || last === 'and' && chain.includes('should')))) {
    return { kind: 'strong', node, matcher: last };
  }
  if (root === 'should' && chain.length >= 3) return { kind: 'strong', node, matcher: last };

  // Testing Library queries throw when nothing matches: an implicit existence assertion.
  if (IMPLICIT_QUERY.test(last)) return { kind: 'implicit', node, matcher: last };

  // Local and imported helpers that contain assertions, and conventionally named helpers.
  if (chain.length === 1 && ctx.helperNames.has(root)) return { kind: 'custom', node, matcher: root };
  if (chain.length === 2 && ctx.helperNames.has(joined)) return { kind: 'custom', node, matcher: joined };
  // Naming conventions (expectValid(), this.assertOk(), util.assertEqual()) only count in test code:
  // in application code `assertValidUrl()` is input validation, not a test assertion.
  if (ctx.allowThrow !== false) {
    if (chain.length === 1 && root !== 'expect' && root !== 'should' && CUSTOM_HELPER.test(root) && !ctx.plainNames?.has(root)) return { kind: 'custom', node, matcher: root };
    if (chain.length >= 2 && chain[0] === 'this' && CUSTOM_HELPER.test(last)) return { kind: 'custom', node, matcher: last };
    if (chain.length >= 2 && /^(assert|expect)[A-Z]/.test(last)) return { kind: 'custom', node, matcher: chain.slice(-2).join('.') };
  }
  return null;
}

function describeExpect(node, chain, ctx) {
  const matcher = chain[chain.length - 1];
  const negated = chain.includes('not');
  const isAsync = chain.includes('resolves') || chain.includes('rejects') || chain[1] === 'poll' || (ctx.playwright && PLAYWRIGHT_ASYNC.has(matcher));
  const expectCall = findExpectCall(node.callee);
  const actual = expectCall?.arguments[0];
  const expected = node.arguments[0];
  let kind = 'strong';
  if (SNAPSHOT_MATCHERS.has(matcher)) kind = 'snapshot';
  else if (CALL_ONLY_MATCHERS.has(matcher) && !negated) kind = 'call';
  else if (WEAK_MATCHERS.has(matcher) || (negated && WEAK_WHEN_NEGATED.has(matcher))) kind = 'weak';
  else if (INSTANCE_MATCHERS.has(matcher) && expected?.type === 'Identifier' && GENERIC_CLASSES.has(expected.name)) kind = 'weak';
  else if (matcher === 'toHaveProperty' && node.arguments.length < 2) kind = 'weak';
  else if (matcher === 'toBeGreaterThan' && expected && isZeroish(expected)) kind = 'weak';
  else if (matcher === 'toBeGreaterThanOrEqual' && expected?.type === 'NumericLiteral' && expected.value === 0) kind = 'weak';
  const tautology = isTautology(actual, expected, matcher, negated, ctx);
  return { kind, node, matcher, negated, isAsync, actual, expected, tautology };
}

function describeAssertCall(node, method, ctx) {
  const args = node.arguments;
  const unary = ['assert', 'ok', 'true', 'truthy', 'isOk', 'isTrue', 'exists', 'isDefined', 'isNotNull', 'notOk', 'false', 'falsy'];
  let kind = 'strong';
  if (unary.includes(method) && args[0] && !isComparison(args[0])) kind = 'weak';
  if (['isDefined', 'exists', 'isNotNull', 'isNotUndefined', 'instanceOf', 'isObject', 'isArray', 'isFunction', 'typeOf'].includes(method)) kind = 'weak';
  if (method === 'snapshot' || method === 'matchSnapshot') kind = 'snapshot';
  if (method === 'doesNotThrow' || method === 'doesNotReject' || method === 'notThrows') kind = 'weak';
  let tautology = null;
  if (unary.includes(method) && args[0] && isLiteral(args[0])) {
    const falsy = ['false', 'notOk', 'falsy'].includes(method) ? isTruthyLiteral(args[0]) : !isTruthyLiteral(args[0]);
    if (falsy) return { kind: 'fail', node, matcher: method }; // assert(false): "should not get here"
    tautology = 'literal';
  }
  else if (args.length >= 2 && EQUALITY_MATCHERS.has(method) && !/^not/.test(method)) {
    if (normalized(ctx.code, args[0]) === normalized(ctx.code, args[1]) && isPureReference(args[0])) tautology = 'same';
    else if (isLiteral(args[0]) && isLiteral(args[1]) && normalized(ctx.code, args[0]) === normalized(ctx.code, args[1])) tautology = 'literal';
  }
  const isAsync = method === 'rejects' || method === 'doesNotReject';
  return { kind, node, matcher: method, negated: false, isAsync, tautology };
}

/** `x`, `a.b.c`, `a[0]`: evaluating it twice yields the same value. Calls and `new` do not. */
function isPureReference(n) {
  let pure = true;
  walk(n, (x) => {
    if (x.type === 'CallExpression' || x.type === 'NewExpression' || x.type === 'OptionalCallExpression' || x.type === 'TaggedTemplateExpression' || x.type === 'AwaitExpression' || x.type === 'UpdateExpression' || x.type === 'AssignmentExpression' || isFunction(x) || x.type === 'ObjectExpression' || x.type === 'ArrayExpression') { pure = false; return false; }
  });
  return pure;
}

function isTruthyLiteral(n) {
  switch (n.type) {
    case 'BooleanLiteral': return n.value;
    case 'NumericLiteral': return n.value !== 0;
    case 'StringLiteral': return n.value !== '';
    case 'NullLiteral': return false;
    case 'Identifier': return n.name === 'Infinity';
    case 'UnaryExpression': return n.operator === '!' ? !isTruthyLiteral(n.argument) : true;
    default: return true;
  }
}

function isZeroish(n) {
  return n.type === 'NumericLiteral' && (n.value === 0 || n.value === -1);
}

function isComparison(n) {
  return (n.type === 'BinaryExpression' && /^(===|!==|==|!=|<|>|<=|>=|instanceof|in)$/.test(n.operator)) || n.type === 'CallExpression' || n.type === 'LogicalExpression' || (n.type === 'UnaryExpression' && n.operator === '!');
}

function findExpectCall(callee) {
  let cur = callee;
  let found = null;
  while (cur) {
    if (cur.type === 'CallExpression' || cur.type === 'OptionalCallExpression') {
      const c = memberChain(cur.callee);
      if (c[0] === 'expect') found = cur;
      cur = cur.callee;
    } else if (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') cur = cur.object;
    else if (cur.type === 'TSNonNullExpression' || cur.type === 'ParenthesizedExpression') cur = cur.expression;
    else break;
  }
  // `expect.soft(x)` / `expect(x)`: the innermost call carrying the actual value
  return found;
}

/**
 * An assertion that cannot fail (or proves nothing):
 *  - expect(x).toBe(x): actual and expected are the same expression
 *  - expect(true).toBe(true), expect('a').toEqual('a'): both sides are equal literals
 *  - expect(42).toBeDefined(): a literal checked with a one-sided matcher
 */
function isTautology(actual, expected, matcher, negated, ctx) {
  if (!actual || negated) return null;
  if (actual.type === 'ArrowFunctionExpression' || actual.type === 'FunctionExpression') return null;
  const comparesTwoSides = EQUALITY_MATCHERS.has(matcher) || ['toMatchObject', 'toContainEqual', 'toMatch', 'include', 'includes', 'contain', 'toContain'].includes(matcher);
  if (comparesTwoSides && expected) {
    const a = normalized(ctx.code, actual);
    const b = normalized(ctx.code, expected);
    // hash(x) vs hash(x) checks determinism: only plain references are self-comparisons.
    if (a === b) return isLiteral(actual) ? 'literal' : isPureReference(actual) ? 'same' : null;
    return null;
  }
  if (isLiteral(actual) && (!expected || isLiteral(expected)) && !SNAPSHOT_MATCHERS.has(matcher)) return 'literal';
  return null;
}

/** Collect every assertion inside `root` (a function body), with the ancestors needed by rules. */
export function collectAssertions(root, ctx) {
  const found = [];
  walk(root, (node, parent, ancestors) => {
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      // Only the outermost call of a chain is the assertion: skip the inner `expect(x)`.
      if (parent && (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.object === node) {
        const chain = memberChain(node.callee);
        if (chain[0] === 'expect' || chain.includes('should') || chain[0] === 'cy') return;
      }
      const a = classifyCall(node, ctx);
      if (a) found.push({ ...a, ancestors: ancestors.slice(), parent });
    } else if (node.type === 'ExpressionStatement' && (node.expression.type === 'MemberExpression' || node.expression.type === 'OptionalMemberExpression')) {
      // chai property assertions: expect(x).to.be.true / x.should.exist
      const chain = memberChain(node.expression);
      const last = chain[chain.length - 1];
      if ((chain[0] === 'expect' || chain.includes('should')) && CHAI_TERMINALS.has(last)) {
        const kind = ['ok', 'exist', 'called'].includes(last) ? 'weak' : 'strong';
        found.push({ kind, node: node.expression, matcher: last, ancestors: ancestors.slice(), parent: node });
      }
    } else if (node.type === 'TSTypeReference' && node.typeName?.type === 'Identifier' && TYPE_ASSERT.test(node.typeName.name) && parent?.type !== 'TSTypeParameterInstantiation') {
      found.push({ kind: 'type', node, matcher: node.typeName.name, ancestors: ancestors.slice(), parent });
    } else if (node.type === 'TSSatisfiesExpression') {
      found.push({ kind: 'type', node, matcher: 'satisfies', ancestors: ancestors.slice(), parent });
    } else if (node.type === 'ThrowStatement' && ctx.allowThrow !== false && ancestors.some((a) => a.type === 'IfStatement') && !ancestors.some((a) => a.type === 'CatchClause')) {
      // if (actual !== expected) throw new Error(...): a hand-rolled assertion
      found.push({ kind: 'strong', node, matcher: 'throw', ancestors: ancestors.slice(), parent });
    }
  });
  return found;
}

/**
 * Names of functions declared in a file that contain at least one assertion (directly or through
 * another such function). Returns Map<localName, exportedNames[]> plus the set of exported names.
 */
export function findAssertingFunctions(ast, code, { extraHelpers = new Set(), allowThrow = true } = {}) {
  const fns = new Map(); // name -> function node
  const exportsMap = new Map(); // exported name -> local name
  for (const stmt of ast.program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration' ? stmt.declaration : stmt;
    if (decl?.type === 'FunctionDeclaration' && decl.id) {
      fns.set(decl.id.name, decl);
      if (stmt.type === 'ExportNamedDeclaration') exportsMap.set(decl.id.name, decl.id.name);
      if (stmt.type === 'ExportDefaultDeclaration') exportsMap.set('default', decl.id.name);
    } else if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type === 'Identifier' && isFunction(d.init)) {
          fns.set(d.id.name, d.init);
          if (stmt.type === 'ExportNamedDeclaration') exportsMap.set(d.id.name, d.id.name);
        }
      }
    }
    if (stmt.type === 'ExportNamedDeclaration' && !stmt.declaration) {
      for (const s of stmt.specifiers) if (s.local && s.exported) exportsMap.set(s.exported.name ?? s.exported.value, s.local.name);
    }
    if (stmt.type === 'ExportDefaultDeclaration' && stmt.declaration?.type === 'Identifier') exportsMap.set('default', stmt.declaration.name);
    // module.exports = { a, b } / exports.a = fn
    if (stmt.type === 'ExpressionStatement' && stmt.expression.type === 'AssignmentExpression') {
      const left = memberChain(stmt.expression.left);
      const right = stmt.expression.right;
      if (left[0] === 'module' && left[1] === 'exports' && left.length === 2 && right.type === 'ObjectExpression') {
        for (const p of right.properties) {
          if (p.type === 'ObjectProperty' && p.value.type === 'Identifier') exportsMap.set(p.key.name ?? p.key.value, p.value.name);
          if (p.type === 'ObjectProperty' && isFunction(p.value)) { const n = p.key.name ?? p.key.value; fns.set(n, p.value); exportsMap.set(n, n); }
          if (p.type === 'ObjectMethod') { const n = p.key.name; fns.set(n, p); exportsMap.set(n, n); }
        }
      } else if ((left[0] === 'exports' || (left[0] === 'module' && left[1] === 'exports')) && left.length >= 2 && isFunction(right)) {
        const n = left[left.length - 1];
        fns.set(n, right);
        exportsMap.set(n, n);
      }
    }
  }
  // Helpers declared inside describe() blocks or other functions are local helpers too.
  walk(ast.program, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id && !fns.has(node.id.name)) fns.set(node.id.name, node);
    else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && isFunction(node.init) && !fns.has(node.id.name)) fns.set(node.id.name, node.init);
  });
  const asserting = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, fn] of fns) {
      if (asserting.has(name)) continue;
      const helperNames = new Set([...asserting, ...extraHelpers]);
      const params = fn.params?.[0]?.type === 'Identifier' ? fn.params[0].name : null;
      if (collectAssertions(fn.body, { code, helperNames, testParam: params, playwright: false, allowThrow, plainNames: new Set() }).some((a) => a.kind !== 'fail')) {
        asserting.add(name);
        changed = true;
      }
    }
  }
  const exported = new Set();
  for (const [exp, local] of exportsMap) if (asserting.has(local)) exported.add(exp);
  return { local: asserting, exported };
}
