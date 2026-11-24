"""Mutation support for Python sources, stdlib only.

Reads a JSON request on stdin and writes JSON on stdout:
  {"cmd": "map", "tests": [...], "cwd": "..."}
      -> {"testsBySource": {"/abs/src.py": ["/abs/test_x.py", ...]}}
      Which local modules each test imports, followed transitively through local imports,
      so a test that imports a package still maps to the module that does the work.
  {"cmd": "mutants", "files": [...]}
      -> {"mutants": {"/abs/src.py": [{start, end, replacement, original, line, label, probeStart, probeEnd}]}}
      Offsets are UTF-16 code units into the file text, the same indexing JavaScript strings use.
"""
import ast
import json
import os
import re
import sys

TEST_RE = re.compile(r'(^|[\\/])(test_[^\\/]*|[^\\/]*_test|tests|conftest)\.py$')
IGNORED = {'venv', '.venv', 'env', '__pycache__', 'site-packages', '.tox', 'node_modules', '.git'}
SKIP_CALLS = re.compile(r'^(print|log|logger|logging|warnings|LOG|LOGGER)\b')
IGNORE_LINE = re.compile(r'hollowtest-ignore|pragma:\s*no\s*cover')

CMP_FLIP = {ast.Lt: ('<', '<='), ast.LtE: ('<=', '<'), ast.Gt: ('>', '>='), ast.GtE: ('>=', '>'),
            ast.Eq: ('==', '!='), ast.NotEq: ('!=', '=='), ast.Is: ('is', 'is not'), ast.IsNot: ('is not', 'is'),
            ast.In: ('in', 'not in'), ast.NotIn: ('not in', 'in')}
BIN_FLIP = {ast.Add: ('+', '-'), ast.Sub: ('-', '+'), ast.Mult: ('*', '/'), ast.Div: ('/', '*'), ast.FloorDiv: ('//', '*')}
BOOL_FLIP = {ast.And: ('and', 'or'), ast.Or: ('or', 'and')}


def read(path):
    with open(path, encoding='utf-8', newline='') as f:
        return f.read()


class Offsets:
    """Turns ast (line, utf-8 byte column) positions into UTF-16 offsets into the whole text."""

    def __init__(self, text):
        self.text = text
        self.lines = re.split(r'(?<=\r\n)|(?<=\n)|(?<=\r)(?!\n)', text)
        self.starts = []
        pos = 0
        for line in self.lines:
            self.starts.append(pos)
            pos += utf16_len(line)

    def at(self, lineno, col):
        line = self.lines[lineno - 1] if lineno - 1 < len(self.lines) else ''
        prefix = line.encode('utf-8')[:col].decode('utf-8', errors='ignore')
        return self.starts[lineno - 1] + utf16_len(prefix)

    def line_text(self, lineno):
        return self.lines[lineno - 1] if 0 < lineno <= len(self.lines) else ''


def utf16_len(s):
    return len(s.encode('utf-16-le')) // 2


def utf16_slice(s, start, end):
    b = s.encode('utf-16-le')
    return b[start * 2:end * 2].decode('utf-16-le', errors='ignore')


def find_mutants(path):
    try:
        text = read(path)
        tree = ast.parse(text, filename=path)
    except (SyntaxError, ValueError, UnicodeDecodeError, OSError):
        return []
    off = Offsets(text)
    out = []

    def start_of(node):
        return off.at(node.lineno, node.col_offset)

    def end_of(node):
        return off.at(node.end_lineno, node.end_col_offset)

    def add(start, end, replacement, label, probe):
        line = text.count('\n', 0, len(utf16_slice(text, 0, start))) + 1 if '\n' in text else 1
        if IGNORE_LINE.search(off.line_text(line)) or IGNORE_LINE.search(off.line_text(line - 1)) and off.line_text(line - 1).lstrip().startswith('#'):
            return
        out.append({'start': start, 'end': end, 'replacement': replacement, 'original': utf16_slice(text, start, end),
                    'line': line, 'label': label, 'probeStart': probe[0], 'probeEnd': probe[1]})

    def operator_between(left, right, token):
        """Offset of an operator token that sits between two nodes (skipping parentheses and spaces)."""
        a, b = end_of(left), start_of(right)
        gap = utf16_slice(text, a, b)
        # The gap holds only the operator, whitespace, parentheses and maybe a comment or line break.
        pattern = r'\s+'.join(map(re.escape, token.split()))
        if token[0].isalpha():
            pattern = r'\b' + pattern + r'\b'
        m = re.search(pattern, gap)
        if not m:
            return None
        return a + utf16_len(gap[:m.start()]), a + utf16_len(gap[:m.end()])

    def is_str(node):
        return isinstance(node, ast.JoinedStr) or (isinstance(node, ast.Constant) and isinstance(node.value, (str, bytes)))

    def visit(node, parent):
        # Type annotations, docstring-free constants in signatures of logging calls: not behavior.
        if isinstance(node, ast.Call):
            try:
                callee = ast.unparse(node.func) if hasattr(ast, 'unparse') else ''
            except Exception:
                callee = ''
            if SKIP_CALLS.match(callee):
                return
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.JoinedStr)):
            return
        probe = (start_of(node), end_of(node)) if hasattr(node, 'end_col_offset') and isinstance(node, ast.expr) else None

        if isinstance(node, ast.Compare):
            prev = node.left
            for op, right in zip(node.ops, node.comparators):
                flip = CMP_FLIP.get(type(op))
                if flip:
                    span = operator_between(prev, right, flip[0])
                    if span:
                        add(span[0], span[1], flip[1], f'{flip[0]} → {flip[1]}', probe)
                prev = right
        elif isinstance(node, ast.BinOp) and type(node.op) in BIN_FLIP:
            flip = BIN_FLIP[type(node.op)]
            if not (isinstance(node.op, ast.Add) and (is_str(node.left) or is_str(node.right))):
                span = operator_between(node.left, node.right, flip[0])
                if span:
                    add(span[0], span[1], flip[1], f'{flip[0]} → {flip[1]}', probe)
        elif isinstance(node, ast.BoolOp):
            flip = BOOL_FLIP[type(node.op)]
            span = operator_between(node.values[0], node.values[1], flip[0])
            if span:
                add(span[0], span[1], flip[1], f'{flip[0]} → {flip[1]}', probe)
        elif isinstance(node, ast.AugAssign) and type(node.op) in BIN_FLIP:
            flip = BIN_FLIP[type(node.op)]
            span = operator_between(node.target, node.value, flip[0] + '=')
            if span:
                add(span[0], span[1], flip[1] + '=', f'{flip[0]}= → {flip[1]}=', (start_of(node.value), end_of(node.value)))
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not) and not isinstance(parent, ast.UnaryOp):
            add(start_of(node), start_of(node.operand), '', 'remove not', probe)
        elif isinstance(node, ast.Constant) and isinstance(node.value, bool):
            add(start_of(node), end_of(node), str(not node.value), f'{node.value} → {not node.value}', probe)
        elif isinstance(node, ast.Constant) and type(node.value) in (int, float) and node.value != 0 \
                and not isinstance(parent, (ast.Subscript, ast.Slice, ast.UnaryOp)):
            new = node.value + 1
            add(start_of(node), end_of(node), repr(new), f'{node.value} → {new}', probe)
        elif isinstance(node, ast.If) and not is_main_guard(node):
            t = node.test
            rep = 'False' if node.orelse else 'True'
            add(start_of(t), end_of(t), rep, f'if … → if {rep}', (start_of(t), end_of(t)))
        elif isinstance(node, ast.IfExp):
            t = node.test
            add(start_of(t), end_of(t), 'False', 'conditional → always else', (start_of(t), end_of(t)))
        elif isinstance(node, ast.Return) and node.value is not None \
                and not isinstance(node.value, ast.Name) \
                and not (isinstance(node.value, ast.Constant) and node.value.value is None):
            v = node.value
            add(start_of(v), end_of(v), 'None', 'return … → return None', (start_of(v), end_of(v)))

        for field, value in ast.iter_fields(node):
            if field in ('annotation', 'returns', 'type_comment', 'decorator_list'):
                continue
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
                continue  # docstrings and bare constants
            if isinstance(value, list):
                for child in value:
                    if isinstance(child, ast.AST):
                        visit(child, node)
            elif isinstance(value, ast.AST):
                visit(value, node)

    visit(tree, None)
    return out


def is_main_guard(node):
    t = node.test
    return isinstance(t, ast.Compare) and isinstance(t.left, ast.Name) and t.left.id == '__name__'


# ---------------------------------------------------------------- import map

def is_ignored(path):
    parts = re.split(r'[\\/]', path)
    return any(p in IGNORED for p in parts)


def module_file(root, dotted):
    base = os.path.join(root, *dotted.split('.'))
    for cand in (base + '.py', os.path.join(base, '__init__.py')):
        if os.path.isfile(cand):
            return os.path.abspath(cand)
    return None


def package_dir(path, level):
    d = os.path.dirname(path)
    for _ in range(level - 1):
        d = os.path.dirname(d)
    return d


def local_imports(path, roots):
    """Local .py files a module imports (absolute or relative)."""
    try:
        tree = ast.parse(read(path), filename=path)
    except (SyntaxError, ValueError, UnicodeDecodeError, OSError):
        return set()
    found = set()

    def resolve(dotted, search):
        for r in search:
            f = module_file(r, dotted)
            if f and not is_ignored(f):
                return f
        return None

    here = [os.path.dirname(path)] + roots
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                parts = a.name.split('.')
                for i in range(len(parts), 0, -1):
                    f = resolve('.'.join(parts[:i]), here)
                    if f:
                        found.add(f)
                        break
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = package_dir(path, node.level)
                mod = node.module or ''
                f = module_file(base, mod) if mod else None
                if f:
                    found.add(f)
                for a in node.names:
                    sub = module_file(base, (mod + '.' if mod else '') + a.name)
                    if sub:
                        found.add(sub)
            elif node.module:
                f = resolve(node.module, here)
                if f:
                    found.add(f)
                for a in node.names:
                    sub = resolve(node.module + '.' + a.name, here)
                    if sub:
                        found.add(sub)
    found.discard(os.path.abspath(path))
    return found


def build_map(tests, cwd):
    roots = [cwd, os.path.join(cwd, 'src'), os.path.join(cwd, 'lib')]
    roots = [r for r in roots if os.path.isdir(r)]
    cache = {}
    by_source = {}
    for t in tests:
        t = os.path.abspath(t)
        roots_t = roots + [os.path.dirname(os.path.dirname(t))]
        seen = set()
        todo = list(local_imports(t, roots_t))
        depth = {f: 1 for f in todo}
        while todo:
            f = todo.pop()
            if f in seen:
                continue
            seen.add(f)
            if depth[f] >= 4:
                continue
            if f not in cache:
                cache[f] = local_imports(f, roots_t)
            for g in cache[f]:
                if g not in depth:
                    depth[g] = depth[f] + 1
                    todo.append(g)
        for f in seen:
            if TEST_RE.search(f.replace('\\', '/')):
                continue
            by_source.setdefault(f, set()).add(t)
    return {k: sorted(v) for k, v in by_source.items()}


def main():
    req = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    if req['cmd'] == 'map':
        print(json.dumps({'testsBySource': build_map(req['tests'], req.get('cwd') or os.getcwd())}))
    elif req['cmd'] == 'mutants':
        print(json.dumps({'mutants': {f: find_mutants(f) for f in req['files']}}))
    else:
        raise SystemExit('unknown cmd')


if __name__ == '__main__':
    main()
