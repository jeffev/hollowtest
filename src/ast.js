import { parse } from '@babel/parser';

/** Parse JS/TS/JSX source into a Babel AST, tolerant of most syntax in the wild. */
export function parseSource(code, filename = '') {
  const isTS = /\.(c|m)?tsx?$/.test(filename);
  const plugins = [
    'jsx',
    isTS ? 'typescript' : 'flow',
    'decorators-legacy',
    'classProperties',
    'topLevelAwait',
    'importAttributes',
    'explicitResourceManagement',
  ];
  return parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    errorRecovery: true,
    attachComment: true,
    plugins,
  });
}

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens']);

/**
 * Depth-first walk. visitor(node, parent, ancestors) may return false to skip children.
 * ancestors is the live stack (outermost first), do not keep references to it.
 */
export function walk(node, visitor, parent = null, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  if (visitor(node, parent, ancestors) === false) return;
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') walk(child, visitor, node, ancestors);
    } else if (value && typeof value.type === 'string') {
      walk(value, visitor, node, ancestors);
    }
  }
  ancestors.pop();
}

/** Flatten a callee like `it.only.each` or `expect(x).not.toBe` into its member chain. */
export function memberChain(node) {
  const parts = [];
  let cur = node;
  while (cur) {
    if (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') {
      parts.unshift(propName(cur));
      cur = cur.object;
    } else if (cur.type === 'CallExpression' || cur.type === 'OptionalCallExpression') {
      parts.unshift('()');
      cur = cur.callee;
    } else if (cur.type === 'TaggedTemplateExpression') {
      parts.unshift('``');
      cur = cur.tag;
    } else if (cur.type === 'Identifier') {
      parts.unshift(cur.name);
      break;
    } else if (cur.type === 'ThisExpression') {
      parts.unshift('this');
      break;
    } else if (cur.type === 'TSNonNullExpression' || cur.type === 'TSAsExpression' || cur.type === 'ParenthesizedExpression') {
      cur = cur.expression;
    } else {
      parts.unshift('?');
      break;
    }
  }
  return parts;
}

export function propName(member) {
  const p = member.property;
  if (!p) return '?';
  if (!member.computed && p.type === 'Identifier') return p.name;
  if (p.type === 'StringLiteral') return p.value;
  if (p.type === 'PrivateName') return '#' + p.id.name;
  return '[]';
}

/** Root identifier name of a call/member chain, e.g. `expect` for expect(a).toBe(b). */
export function rootName(node) {
  const chain = memberChain(node);
  return chain[0];
}

export function isFunction(node) {
  return node && (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration' || node.type === 'ObjectMethod' || node.type === 'ClassMethod');
}

export function sourceOf(code, node) {
  return code.slice(node.start, node.end);
}

/** Source text with whitespace and trailing commas normalized, for structural comparison. */
export function normalized(code, node) {
  return sourceOf(code, node).replace(/\s+/g, '').replace(/,([)\]}])/g, '$1');
}

export function isLiteral(node) {
  if (!node) return false;
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'BigIntLiteral':
    case 'RegExpLiteral':
      return true;
    case 'TemplateLiteral':
      return node.expressions.length === 0;
    case 'Identifier':
      return node.name === 'undefined' || node.name === 'NaN' || node.name === 'Infinity';
    case 'UnaryExpression':
      return (node.operator === '-' || node.operator === '+' || node.operator === '!') && isLiteral(node.argument);
    case 'ArrayExpression':
      return node.elements.every((e) => e && isLiteral(e));
    case 'ObjectExpression':
      return node.properties.every((p) => p.type === 'ObjectProperty' && !p.computed && isLiteral(p.value));
    default:
      return false;
  }
}
