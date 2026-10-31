"""hollowtest for Python (pytest, unittest). Reads a JSON list of file paths on stdin and writes
JSON results on stdout in the same shape as the JavaScript analyzer. Standard library only."""
import ast
import json
import os
import re
import sys

# validate_*/check_* are everyday library names in Python (pydantic.validate_python), so only assert/expect/verify count
ASSERT_NAME = re.compile(r"^(assert|expect|verify)(_|[A-Z0-9]|$)")
HELPER_PATH = re.compile(r"(test|conftest|helper|fixture|support|assert|expect|verify)", re.I)
SMOKE_NAME = re.compile(r"(not_|n_?t_|never_)(raise|crash|fail|error|throw|break)|smoke|no_error|without_(error|crash|raising)|_(runs|works|passes|accepts|allows|valid|succeeds|imports?)$|^test_(valid|accepts|allows|import|success|can_(access|import|create|instantiate|be_))", re.I)
SMOKE_DOC = re.compile(r"nothing happens|(does not|doesn't|should not|shouldn't|won't|never) (raise|crash|fail|error|throw)|no (exception|error) is raised|without (raising|errors?)|is silent|silently|neither direction raises|can be (constructed|created|instantiated|subclassed|defined|imported|pickled)", re.I)
GENERIC_TYPES = {"object", "dict", "list", "str", "int", "float", "tuple", "set", "bool", "bytes", "type", "Exception", "BaseException", "Mapping", "Sequence", "Iterable"}
MOCK_STRONG = {"assert_called_with", "assert_called_once_with", "assert_any_call", "assert_has_calls", "assert_not_called", "assert_awaited_with", "assert_awaited_once_with", "assert_any_await", "assert_has_awaits", "assert_not_awaited"}
MOCK_WEAK = {"assert_called", "assert_called_once", "assert_awaited", "assert_awaited_once"}
UNITTEST_WEAK = {"assertIsNotNone", "assertTrue", "assertIsInstance"}
UNITTEST_EQ = {"assertEqual", "assertEquals", "assertIs", "assertListEqual", "assertDictEqual", "assertTupleEqual", "assertSetEqual", "assertSequenceEqual", "assertMultiLineEqual", "assertCountEqual", "assertAlmostEqual"}
RAISES = {"raises", "warns", "deprecated_call", "assertRaises", "assertRaisesRegex", "assertWarns", "assertWarnsRegex", "assertLogs", "assertNoLogs"}
SKIP_DECOS = {"skip", "skipTest"}
COMMENTED = re.compile(r"^\s*#\s*(assert\b|self\.assert|pytest\.raises|mock_\w+\.assert_|\w+\.assert_called)")


def chain(node):
    """Dotted name of a call target: pytest.mark.skip, self.assertEqual, mock.assert_called."""
    parts = []
    while True:
        if isinstance(node, ast.Attribute):
            parts.append(node.attr)
            node = node.value
        elif isinstance(node, ast.Call):
            node = node.func
        elif isinstance(node, ast.Name):
            parts.append(node.id)
            break
        else:
            parts.append("?")
            break
    return ".".join(reversed(parts))


def is_pure(node):
    """Evaluating it twice gives the same value: names, attributes, subscripts with constants."""
    for n in ast.walk(node):
        if isinstance(n, (ast.Call, ast.Await, ast.Lambda, ast.ListComp, ast.DictComp, ast.SetComp, ast.GeneratorExp, ast.NamedExpr, ast.Yield, ast.YieldFrom, ast.List, ast.Dict, ast.Set)):
            return False
    return True


def is_const(node):
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return all(is_const(e) for e in node.elts)
    if isinstance(node, ast.UnaryOp):
        return is_const(node.operand)
    return False


def const_truthy(node):
    try:
        return bool(ast.literal_eval(node))
    except Exception:
        return True


def same(a, b):
    return ast.dump(a) == ast.dump(b)


class Ctx:
    def __init__(self, helpers, plain, unknown):
        self.helpers = helpers  # names of functions known to assert
        self.plain = plain  # names imported from code we inspected: not assertions by name
        self.unknown = unknown  # names imported from test-ish modules we could not read


def classify_assert(node):
    """ast.Assert -> (kind, tautology)."""
    t = node.test
    if isinstance(t, ast.Tuple) and t.elts:
        return "strong", "tuple"
    if is_const(t):
        return ("strong", "literal") if const_truthy(t) else ("fail", None)
    if isinstance(t, ast.Compare) and len(t.ops) == 1:
        left, right, op = t.left, t.comparators[0], t.ops[0]
        if isinstance(op, (ast.Eq, ast.Is, ast.GtE, ast.LtE)) and same(left, right) and is_pure(left):
            return "strong", "same"
        if is_const(left) and is_const(right):
            return "strong", "literal"
        if isinstance(right, ast.Name) and right.id == "snapshot" or isinstance(left, ast.Name) and left.id == "snapshot":
            return "snapshot", None
        if isinstance(op, (ast.IsNot, ast.NotEq)) and isinstance(right, ast.Constant) and right.value is None:
            return "weak", None
        if isinstance(left, ast.Call) and chain(left.func) == "len" and isinstance(right, ast.Constant):
            if (isinstance(op, ast.Gt) and right.value == 0) or (isinstance(op, ast.GtE) and right.value in (0, 1)) or (isinstance(op, ast.NotEq) and right.value == 0):
                return "weak", None
        return "strong", None
    if isinstance(t, (ast.Name, ast.Attribute, ast.Subscript)):
        # `assert df.empty`, `assert col.is_unique`: a named boolean property, not vague truthiness
        if isinstance(t, ast.Attribute) and BOOL_ATTR.match(t.attr):
            return "strong", None
        return "weak", None
    if isinstance(t, ast.Call):
        fn = chain(t.func)
        if fn in ("isinstance",) and len(t.args) == 2:
            types = t.args[1].elts if isinstance(t.args[1], ast.Tuple) else [t.args[1]]
            if all(isinstance(x, (ast.Name, ast.Attribute)) and chain(x).split(".")[-1] in GENERIC_TYPES for x in types):
                return "weak", None
        if fn in ("callable", "hasattr", "bool"):
            return "weak", None
    return "strong", None


def classify_call(node, ctx, unittest_self):
    fn = chain(node.func)
    last = fn.split(".")[-1]
    args = node.args
    if fn in ("pytest.fail", "self.fail", "fail") or (unittest_self and fn == unittest_self + ".fail"):
        return "fail", None
    if last in RAISES and (fn.startswith("pytest.") or fn.startswith("self.") or fn.startswith("unittest.")):
        return "strong", None
    if last in MOCK_STRONG:
        return "strong", None
    if last in MOCK_WEAK:
        return "call", None
    if fn.startswith("self.assert") or (unittest_self and fn.startswith(unittest_self + ".assert")):
        if last in UNITTEST_EQ and len(args) >= 2:
            if same(args[0], args[1]) and is_pure(args[0]):
                return "strong", "literal" if is_const(args[0]) else "same"
            if is_const(args[0]) and is_const(args[1]):
                return "strong", "literal"
        if last in ("assertTrue", "assertIsNotNone") and args and is_const(args[0]):
            return ("strong", "literal") if const_truthy(args[0]) else ("fail", None)
        if last == "assertFalse" and args and is_const(args[0]):
            return ("fail", None) if const_truthy(args[0]) else ("strong", "literal")
        if last == "assertIsInstance" and len(args) >= 2:
            types = args[1].elts if isinstance(args[1], ast.Tuple) else [args[1]]
            if all(isinstance(x, (ast.Name, ast.Attribute)) and chain(x).split(".")[-1] in GENERIC_TYPES for x in types):
                return "weak", None
            return "strong", None
        if last in ("assertTrue",) and args and isinstance(args[0], (ast.Name, ast.Attribute, ast.Subscript)):
            return "weak", None
        if last in ("assertIsNotNone",):
            return "weak", None
        return "strong", None
    root = fn.split(".")[0]
    if root in ctx.helpers or fn in ctx.helpers:
        return "custom", None
    # np.testing.assert_allclose, pd.testing.assert_frame_equal, assert_that(x).is_equal_to(y)
    if ".testing." in fn or fn.startswith("testing."):
        return "strong", None
    if ASSERT_NAME.match(last) and root not in ctx.plain and last not in ctx.plain:
        return "custom", None
    if root == "assert_that" or fn.startswith("assert_that."):
        return "custom", None
    return None


def parents_map(fn):
    parents = {}
    for p in ast.walk(fn):
        for c in ast.iter_child_nodes(p):
            parents[c] = p
    return parents


def collect(fn, ctx):
    """Every assertion in a test function, with its ancestor chain."""
    unittest_self = fn.args.args[0].arg if fn.args.args and fn.args.args[0].arg in ("self", "cls") else None
    parents = parents_map(fn)
    found = []
    for node in ast.walk(fn):
        kind = taut = None
        if isinstance(node, ast.Assert):
            kind, taut = classify_assert(node)
        elif isinstance(node, ast.Call):
            # inner call of a chain like assert_that(x).is_equal_to(y): count the outer one only
            p = parents.get(node)
            if isinstance(p, ast.Attribute) and isinstance(parents.get(p), ast.Call) and chain(node.func).split(".")[0] in ("assert_that",):
                continue
            r = classify_call(node, ctx, unittest_self)
            if r:
                kind, taut = r
        elif isinstance(node, ast.Raise) and node.exc is not None:
            anc = ancestors(node, parents, fn)
            if any(isinstance(a, ast.If) for a in anc) and not any(isinstance(a, ast.ExceptHandler) for a in anc):
                kind = "strong"
        if kind:
            found.append({"kind": kind, "tautology": taut, "node": node, "anc": ancestors(node, parents, fn)})
    # `raised = True` in an except, then `assert raised`: a boolean flag, not a vague truthiness check
    flags = {t.id for n in ast.walk(fn) if isinstance(n, ast.Assign) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, bool) for t in n.targets if isinstance(t, ast.Name)}
    for a in found:
        t = getattr(a["node"], "test", None)
        if a["kind"] == "weak" and isinstance(t, ast.Name) and t.id in flags:
            a["kind"] = "strong"
    return found, parents


def ancestors(node, parents, stop):
    out = []
    cur = parents.get(node)
    while cur is not None and cur is not stop:
        out.append(cur)
        cur = parents.get(cur)
    out.reverse()
    return out


def contains(node, types):
    return any(isinstance(n, types) for n in ast.walk(node))


def has_fail(node):
    for n in ast.walk(node):
        if isinstance(n, ast.Raise):
            return True
        if isinstance(n, ast.Call) and chain(n.func) in ("pytest.fail", "self.fail", "fail", "os._exit", "sys.exit", "os.abort"):
            return True
        if isinstance(n, ast.Assert) and is_const(n.test) and not const_truthy(n.test):
            return True
    return False


def catches_assertion(handler):
    t = handler.type
    if t is None:
        return True
    names = [chain(x) for x in (t.elts if isinstance(t, ast.Tuple) else [t])]
    return any(n.split(".")[-1] in ("Exception", "BaseException", "AssertionError") for n in names)


def nonempty_iter(node):
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)) and node.elts:
        return True
    if isinstance(node, ast.Dict) and node.keys:
        return True
    if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value:
        return True
    if isinstance(node, ast.Call) and chain(node.func) == "range" and node.args:
        try:
            vals = [ast.literal_eval(a) for a in node.args]
            return len(range(*vals)) > 0
        except Exception:
            return False
    return False


PURE_CALLS = {"isinstance", "len", "type", "callable", "hasattr", "bool", "issubclass"}


def only_params(test, params):
    """The condition depends only on test parameters (plus class names and pure builtins)."""
    for n in ast.walk(test):
        if isinstance(n, ast.Call) and not (isinstance(n.func, ast.Name) and n.func.id in PURE_CALLS):
            return False
    names = [n.id for n in ast.walk(test) if isinstance(n, ast.Name) and n.id not in PURE_CALLS]
    ok = all(x in params or x in ("None", "True", "False") or x[:1].isupper() for x in names)
    return ok and any(x in params for x in names)


def branch_asserts(stmts, nodes):
    ids = {id(x) for x in nodes}
    return any(id(n) in ids for s in stmts for n in ast.walk(s))


def conditional_reason(a, all_nodes=(), params=()):
    anc = a["anc"]
    for i, n in enumerate(anc):
        child = anc[i + 1] if i + 1 < len(anc) else a["node"]
        if isinstance(n, ast.If) and child is not n.test:
            # parametrized split (`if error:` on a test parameter) asserting on both paths: fine;
            # a runtime condition still lets the real check be skipped
            if n.orelse and only_params(n.test, params) and branch_asserts(n.body, all_nodes) and branch_asserts(n.orelse, all_nodes):
                continue
            return "inside an `if`"
        if isinstance(n, ast.IfExp) and child is not n.test:
            return "inside a conditional expression"
        if isinstance(n, (ast.For, ast.AsyncFor)) and child in n.body and not nonempty_iter(n.iter) and not (isinstance(n.iter, ast.Name) and n.iter.id in LITERAL_VARS) and not iterates_constant(n.iter):
            return "inside a loop"
        if isinstance(n, ast.While) and child in n.body:
            return "inside a loop"
    return None


LITERAL_VARS = set()  # names bound to a non-empty literal list/tuple/dict in the current file
BOOL_ATTR = re.compile(r"^(empty|closed|done|ok|alive|exists|enabled|disabled|active|valid|success|cancelled|readonly|frozen|(is|has|can|should|was|were)_\w+)$")


def iterates_constant(it):
    """for p in ASSET_PROXIES / PROFILES.items() / cfg.PHASES: configuration data, known to be non-empty."""
    if isinstance(it, ast.Call) and isinstance(it.func, ast.Attribute) and it.func.attr in ("items", "keys", "values"):
        it = it.func.value
    name = it.attr if isinstance(it, ast.Attribute) else it.id if isinstance(it, ast.Name) else ""
    return len(name) > 1 and name.isupper()


def finding(rule, severity, line, message):
    return {"rule": rule, "severity": severity, "line": line, "message": message}


def check_test(fn, ctx, source_lines, mode):
    findings = []
    body = [s for s in fn.body if not (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant))]
    empty = not body or all(isinstance(s, ast.Pass) or (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant) and s.value.value is Ellipsis) for s in body)
    asserts, parents = collect(fn, ctx)
    real = [a for a in asserts if a["kind"] != "fail"]
    name = fn.name
    smoke = bool(SMOKE_NAME.search(name)) or bool(SMOKE_DOC.search(ast.get_docstring(fn) or ""))
    # Hypothesis @given: "for any input, it works or raises the right error" is the point of the test
    property_test = any(chain(d.func if isinstance(d, ast.Call) else d).split(".")[-1] == "given" for d in fn.decorator_list)
    smoke = smoke or property_test
    params = {a.arg for a in fn.args.args}

    if empty:
        findings.append(finding("empty-test", "error", fn.lineno, "Test body is empty: it always passes."))
    elif not real and not any(a["kind"] == "fail" for a in asserts) and "benchmark" not in params:
        called_unknown = sorted({chain(n.func).split(".")[0] for n in ast.walk(fn) if isinstance(n, ast.Call) and chain(n.func).split(".")[0] in ctx.unknown})
        if called_unknown:
            findings.append(finding("no-assertions", "warn", fn.lineno, "No assertions found. It calls %s, which hollowtest could not inspect; make sure it asserts." % ", ".join(c + "()" for c in called_unknown)))
        elif smoke:
            findings.append(finding("no-assertions", "warn", fn.lineno, "No assertions: this is a smoke test that only checks nothing raises. Assert on the output too."))
        else:
            findings.append(finding("no-assertions", "error", fn.lineno, "No assertions: this test passes as long as nothing raises."))

    others = [a for a in real if not a["tautology"]]
    for a in asserts:
        if a["tautology"] == "tuple":
            findings.append(finding("tautology", "error", a["node"].lineno, "`assert (cond, \"msg\")` is always true: a non-empty tuple is truthy. Write `assert cond, \"msg\"`."))
        elif a["tautology"]:
            seg = (ast.get_source_segment("\n".join(source_lines), a["node"]) or "").replace("\n", " ")
            seg = seg if len(seg) <= 70 else seg[:67] + "..."
            msg = ("Compares a value with itself: `%s`." if a["tautology"] == "same" else "Asserts on a constant, so it can never fail: `%s`.") % seg
            findings.append(finding("tautology", "warn" if others else "error", a["node"].lineno, msg))

    for node in ast.walk(fn):
        if not isinstance(node, ast.Try) or not node.handlers:
            continue
        in_body = [a for a in asserts if any(x in node.body for x in a["anc"] + [a["node"]])]
        # `assert False` / pytest.fail in except means "must not raise": the opposite of swallowing
        in_handlers = [a for a in asserts if a["kind"] != "fail" and any(h in a["anc"] for h in node.handlers)]
        guarded = has_fail(ast.Module(body=node.body, type_ignores=[])) or has_fail(ast.Module(body=node.orelse, type_ignores=[]))
        flag_after = flag_checked_after(node, asserts)
        if in_handlers and not in_body and not guarded and not flag_after and not property_test:
            findings.append(finding("swallowed-error", "error", node.lineno, "The assertions live in `except`; if the code stops raising, this test still passes. Use `with pytest.raises(...)` (or `self.assertRaises`)."))
        elif in_body and any(catches_assertion(h) and not has_fail(ast.Module(body=h.body, type_ignores=[])) and not any(a["node"] in list(ast.walk(h)) for a in asserts) for h in node.handlers):
            findings.append(finding("swallowed-error", "error", node.lineno, "Assertions inside `try` are swallowed: `except Exception` (or a bare `except`) also catches AssertionError and does not re-raise."))

    rs = [a for a in real if not isinstance(a["node"], ast.Raise) and not any(isinstance(x, ast.ExceptHandler) for x in a["anc"])]
    if rs:
        nodes = [a["node"] for a in real]
        reasons = [conditional_reason(a, nodes, params) for a in rs]
        if all(reasons):
            findings.append(finding("conditional-assertion", "warn", rs[0]["node"].lineno, "Every assertion is %s; when that never happens, the test passes without checking anything." % reasons[0]))

    # The AST ends at the last statement; trailing comments belong to the function until the indent drops.
    commented = []
    for i in range(fn.lineno, len(source_lines)):
        line = source_lines[i]
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and len(line) - len(line.lstrip()) <= fn.col_offset:
            break
        if stripped.startswith("#") and len(line) - len(line.lstrip()) <= fn.col_offset:
            break
        if COMMENTED.match(line):
            commented.append(i + 1)
    if commented:
        findings.append(finding("commented-assertion", "warn", commented[0], "%d assertion%s commented out." % (len(commented), "s are" if len(commented) > 1 else " is")))

    strong_like = [a for a in real if not a["tautology"]]
    if strong_like and all(a["kind"] in ("weak", "call") for a in strong_like):
        findings.append(finding("weak-assertions", "warn", strong_like[0]["node"].lineno, "Only weak checks (truthiness, `is not None`, `len(x) > 0`, bare `assert_called()`): almost any result passes. Assert on the actual value."))
    if real and all(a["kind"] == "snapshot" for a in real):
        findings.append(finding("snapshot-only", "info", real[0]["node"].lineno, "The only assertion is a snapshot; it gets regenerated instead of read when it fails."))

    if mode == "skip":
        findings = [f for f in findings if f["rule"] not in ("empty-test", "no-assertions")]
        findings.append(finding("skipped-test", "warn", fn.lineno, "Test is skipped, so it verifies nothing. Agents often skip a failing test instead of fixing the code."))
    elif mode == "xfail":
        findings.append(finding("skipped-test", "warn", fn.lineno, "Marked xfail: a failing test that is allowed to fail checks nothing. Fix the code or the test."))
    return findings, len(real)


def flag_checked_after(try_node, asserts):
    touched = set()
    for h in try_node.handlers:
        if h.name:
            touched.add(h.name)
        for n in ast.walk(h):
            if isinstance(n, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
                targets = n.targets if isinstance(n, ast.Assign) else [n.target]
                for t in targets:
                    if isinstance(t, ast.Name):
                        touched.add(t.id)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ("append", "add", "update") and isinstance(n.func.value, ast.Name):
                touched.add(n.func.value.id)
    end = getattr(try_node, "end_lineno", try_node.lineno)
    for a in asserts:
        if a["node"].lineno > end and any(isinstance(n, ast.Name) and n.id in touched for n in ast.walk(a["node"])):
            return True
    return False


def decorator_mode(decorators):
    mode = "run"
    for d in decorators:
        name = chain(d.func if isinstance(d, ast.Call) else d)
        last = name.split(".")[-1]
        if last in SKIP_DECOS or name.endswith("mark.skip"):
            mode = "skip"
        elif last == "xfail" and mode == "run":
            # xfail(strict=True) still fails when the test unexpectedly passes: that is a real check
            strict = isinstance(d, ast.Call) and any(k.arg == "strict" and isinstance(k.value, ast.Constant) and k.value.value for k in d.keywords)
            if not strict:
                mode = "xfail"
    return mode


def asserting_functions(tree):
    """Helper functions (in a test file or test-helper module) that contain assertions."""
    fns = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("test"):
            fns[node.name] = node
    asserting = set()
    changed = True
    while changed:
        changed = False
        for name, fn in fns.items():
            if name in asserting:
                continue
            asserts, _ = collect(fn, Ctx(asserting, set(), set()))
            if any(a["kind"] != "fail" for a in asserts):
                asserting.add(name)
                changed = True
    return asserting


def resolve_module(module, level, file, cwd):
    parts = module.split(".") if module else []
    bases = []
    if level:
        base = os.path.dirname(file)
        for _ in range(level - 1):
            base = os.path.dirname(base)
        bases.append(base)
    else:
        bases += [os.path.dirname(file), cwd, os.path.join(cwd, "src")]
    for b in bases:
        p = os.path.join(b, *parts)
        for cand in (p + ".py", os.path.join(p, "__init__.py")):
            if os.path.isfile(cand):
                return cand
    return None


_cache = {}


def module_asserting(path):
    if path in _cache:
        return _cache[path]
    res = None
    try:
        with open(path, encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
        # Application code uses `assert` for invariants; only test helpers count as assertion helpers.
        is_helper = HELPER_PATH.search(os.path.basename(path)) or re.search(r"^(tests?|testing|helpers?|fixtures?|support|test_?utils)$", os.path.basename(os.path.dirname(path)), re.I)
        res = asserting_functions(tree) if is_helper else set()
    except Exception:
        res = None
    _cache[path] = res
    return res


def import_context(tree, file, cwd):
    helpers, plain, unknown = set(), set(), set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom):
            if node.module in ("pytest", "unittest", "unittest.mock", "mock", "typing", "__future__") or (node.module or "").startswith(("pytest", "unittest", "hypothesis", "numpy", "pandas")):
                continue
            target = resolve_module(node.module or "", node.level, file, cwd)
            names = [(a.asname or a.name, a.name) for a in node.names]
            if target:
                exp = module_asserting(target)
                for local, orig in names:
                    if exp and orig in exp:
                        helpers.add(local)
                    else:
                        plain.add(local)
            elif HELPER_PATH.search(node.module or ""):
                for local, _ in names:
                    unknown.add(local)
    # conftest.py helpers in the same folder and above
    d = os.path.dirname(file)
    for _ in range(4):
        c = os.path.join(d, "conftest.py")
        if os.path.isfile(c):
            exp = module_asserting(c) or set()
            helpers |= exp
        if os.path.abspath(d) == os.path.abspath(cwd) or os.path.dirname(d) == d:
            break
        d = os.path.dirname(d)
    return helpers, plain, unknown


def mocked_subject(tree, file):
    base = os.path.basename(file)[:-3]
    subject = base[5:] if base.startswith("test_") else base[:-5] if base.endswith("_test") else None
    if not subject:
        return []
    imported = set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module and node.module.split(".")[-1] == subject:
            imported |= {a.name for a in node.names}
    if not imported:
        return []
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = chain(node.func)
        if not (fn.endswith("patch") or fn.endswith("mocker.patch") or fn == "monkeypatch.setattr") or not node.args:
            continue
        target = node.args[0]
        if isinstance(target, ast.Constant) and isinstance(target.value, str):
            parts = target.value.split(".")
            if len(parts) >= 2 and parts[-2] == subject and parts[-1] in imported:
                f = finding("mocked-subject", "error", node.lineno, "%s('%s') replaces the function this file is testing; the assertions check the mock, not the real code." % (fn, target.value))
                f["target"] = target.value
                out.append(f)
    return out


def analyze(file, cwd):
    with open(file, encoding="utf-8", errors="replace") as fh:
        source = fh.read()
    try:
        tree = ast.parse(source, filename=file)
    except SyntaxError as e:
        return {"file": file, "tests": [], "fileFindings": [], "parseError": "%s (line %s)" % (e.msg, e.lineno)}
    lines = source.split("\n")
    LITERAL_VARS.clear()
    for n in ast.walk(tree):
        if isinstance(n, ast.Assign) and nonempty_iter(n.value):
            LITERAL_VARS.update(t.id for t in n.targets if isinstance(t, ast.Name))
    local = asserting_functions(tree)
    helpers, plain, unknown = import_context(tree, file, cwd)
    ctx = Ctx(local | helpers, plain, unknown)
    tests = []

    def visit_fn(fn, class_mode):
        mode = decorator_mode(fn.decorator_list)
        if class_mode != "run" and mode == "run":
            mode = class_mode
        first = [s for s in fn.body if not (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant))]
        if first and isinstance(first[0], ast.Expr) and isinstance(first[0].value, ast.Call) and chain(first[0].value.func) in ("pytest.skip", "self.skipTest"):
            mode = "skip"
        if any(a.arg == "benchmark" for a in fn.args.args):
            tests.append({"name": fn.name, "line": fn.lineno, "endLine": getattr(fn, "end_lineno", fn.lineno), "mode": "external", "assertions": 0, "findings": []})
            return
        findings, n = check_test(fn, ctx, lines, mode)
        tests.append({"name": fn.name, "line": fn.lineno, "endLine": getattr(fn, "end_lineno", fn.lineno), "mode": "skip" if mode in ("skip",) else "run", "assertions": n, "findings": findings})

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test"):
            visit_fn(node, "run")
        elif isinstance(node, ast.ClassDef):
            is_case = node.name.startswith("Test") or any(chain(b).endswith("TestCase") for b in node.bases)
            if not is_case:
                continue
            cmode = decorator_mode(node.decorator_list)
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name.startswith("test"):
                    visit_fn(item, cmode)
    file_findings = []
    patched = mocked_subject(tree, file)
    if patched:
        fn_nodes = {n.lineno: n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
        by_name = {n.name: n for n in fn_nodes.values()}
        for t in tests:
            fn = fn_nodes.get(t["line"])
            if not fn:
                continue
            # Only patches active in this test: in its body/decorators or in a fixture it requests.
            scopes = [fn] + [by_name[a.arg] for a in fn.args.args if a.arg in by_name and not a.arg.startswith("test")]
            lines_in_scope = {n.lineno for s in scopes for n in ast.walk(s) if hasattr(n, "lineno")}
            called = {chain(n.func).split(".")[-1] for n in ast.walk(fn) if isinstance(n, ast.Call)}
            hits = [f for f in patched if f["line"] in lines_in_scope and f["target"].split(".")[-1] in called]
            for f in hits[:1]:
                t["findings"].append(finding("mocked-subject", "error", t["line"], "Tests a mock of the function under test: " + f["message"].split(" replaces")[0]))
        if any(f["rule"] == "mocked-subject" for t in tests for f in t["findings"]):
            file_findings = [{k: v for k, v in f.items() if k != "target"} for f in patched]
    return {"file": file, "tests": tests, "fileFindings": file_findings}


def main():
    req = json.load(sys.stdin)
    cwd = req.get("cwd") or os.getcwd()
    out = []
    for f in req["files"]:
        try:
            out.append(analyze(f, cwd))
        except Exception as e:  # never let one file kill the run
            out.append({"file": f, "tests": [], "fileFindings": [], "parseError": "internal error: %s" % e})
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
