# hollowtest

**Find tests that test nothing.**

Coding agents are great at making tests pass. Sometimes they do it by writing tests that cannot fail: no assertions, `expect(x).toBe(x)`, a mock of the very module under test, an `expect` inside a `catch` that never runs, a `.resolves` nobody awaits. Coverage goes green. The bug ships.

`hollowtest` reads your test files and flags those tests in seconds (7,400 tests of NestJS in about 3 s), then (optionally) breaks your code on purpose to prove which behavior no test notices. It ships with an agent skill so Claude Code, Codex and Cursor stop writing them in the first place.

```bash
npx hollowtest
```

```
examples/checkout/checkout.test.ts
  warn   checkout.test.ts:9   calculates the subtotal      Only weak checks (toBeDefined): almost any result passes.
  error  checkout.test.ts:14  applies the HALF coupon      Compares a value with itself: `expect(total).toEqual(total)`.
  error  checkout.test.ts:18  rejects an invalid quantity  The assertions live in `catch`; if the code stops throwing, this test still passes.
  error  checkout.test.ts:27  loads the cart from the API  `toHaveLength` is asynchronous but not awaited or returned: the test finishes before it runs.
  warn   checkout.test.ts:33  calls the API                Only weak checks (toHaveBeenCalled): almost any result passes.
  error  checkout.test.ts:36  handles an empty cart        No assertions: this test passes as long as nothing throws.

Test integrity  29/100  grade F
7 tests in 1 files  ·  4 hollow  ·  2 weak  ·  1 solid
```

That is the real output for [`examples/checkout`](examples/checkout/checkout.test.ts): seven tests in the style agents write when asked to "add tests for checkout". All seven would pass.

Zero config. Works with **Jest, Vitest, Mocha + Chai, node:test, ava, tap, Playwright, Testing Library, supertest** in JS and TS, and with **pytest and unittest** in Python (it uses the Python on your machine; nothing to install). One dependency (the Babel parser).

## What it catches

| Rule | Severity | Example |
|---|---|---|
| `no-assertions` | error | `it('works', () => { total(cart) })` |
| `empty-test` | error | `it('handles errors', () => {})` |
| `tautology` | error | `expect(result).toBe(result)`, `expect(true).toBe(true)` |
| `bare-expect` | error | `expect(x)` with no matcher, or `expect(x).toBeNull` without `()` |
| `swallowed-error` | error | `try { parse('') } catch (e) { expect(e.message)... }` passes when nothing throws |
| `unawaited-assertion` | error | `expect(p).resolves.toBe(1)` without `await`; `expect` inside an un-awaited `.then()` or `setTimeout` |
| `mocked-subject` | error | `cart.test.ts` that calls `vi.mock('./cart')` |
| `focused-test` | error | `.only` left in: every other test in the file silently stops running |
| `conditional-assertion` | warn | every `expect` sits behind an `if`, or in a loop over a list that may be empty |
| `weak-assertions` | warn | only `toBeDefined()`, `toBeTruthy()`, `not.toBeNull()`, bare `toHaveBeenCalled()` |
| `commented-assertion` | warn | `// expect(total).toBe(35)` |
| `skipped-test` | warn | `it.skip(...)`, the classic way to "fix" a failing test |
| `snapshot-only` | info | the only check is a snapshot that gets regenerated with `-u` |

Python gets the same rules, plus two of its own: `assert (cond, "msg")`, which is always true because a non-empty tuple is truthy, and `except Exception:` around assertions, which also catches `AssertionError`. `@pytest.mark.skip` and non-strict `xfail` count as skipped; Hypothesis `@given` property tests and `benchmark` tests are understood.

`npx hollowtest --rules` prints the list with explanations.

It is careful about false positives. It understands helpers that assert (local, or imported from your test utils), Testing Library queries that throw (`getByText`), the mocha `done` callback contract, `expect.assertions(n)`, the `let threw = false` pattern, compile-time type tests (`expectTypeOf`, `Expect<Equal<A, B>>`, `@ts-expect-error`), loops over literal arrays, and "does not throw" smoke tests (reported as warnings, not errors).

## Fix what is mechanical

```bash
npx hollowtest --fix            # or --fix --dry-run to preview
```

```
fixed  checkout.test.ts: add expect.assertions(1), await .toHaveLength
fixed  focused.test.js: remove .only
fixed  test_hollow.py: assert (cond, msg) -> assert cond, msg
```

It only rewrites what has one correct answer: `expect(x).toBeNull` gets its `()`, a floating `.resolves`/`.rejects` gets `await` (and the test becomes `async`), `.only`/`fit`/`fdescribe` are removed, a catch-only test gets `expect.assertions(n)`, and Python's `assert (cond, "msg")` becomes `assert cond, "msg"`. Some fixed tests will start failing. That is the point: they were hiding a failure. Tautologies, missing assertions and weak checks need a human (or your agent with the skill), because only you know the expected value.

## The mutation check: proof, not opinion

Static rules find tests that look hollow. `--mutate` proves it. It changes your code the way a real bug would (`>` becomes `>=`, `&&` becomes `||`, a condition is forced to `true`, a return value becomes `null`), runs only the tests that import that file, and restores the file.

```bash
npx hollowtest --mutate pricing.js
```

```
hollowtest --mutate  1 source file(s), 1 test file(s), runner: node --test {files}
....SSSSSS..S....

  survived  pricing.js:11  > → >=
            if (coupon === 'HALF' && total > 50) {
  survived  pricing.js:11  === → !==
            if (coupon === 'HALF' && total > 50) {
  survived  pricing.js:11  && → ||
            if (coupon === 'HALF' && total > 50) {
  survived  pricing.js:12  / → *
            return total / 2;
  ...

Mutation score  59%  10 of 17 breaking changes caught by a test, 7 slipped through
```

All seven survivors are in `discount()`, the one function whose test only checks `assert.ok(result)` ([`test/mutation-sample`](test/mutation-sample/pricing.test.js)). The well-tested functions next to it lose no mutants.

Every survivor is a bug your tests would let through. It detects Vitest, Jest, Mocha, ava and node:test from `package.json`, or takes `--test-cmd "pnpm test {files}"`. Source files are restored after each mutant, and on Ctrl+C. If the process is killed, the next run restores them from `.hollowtest-restore.json`. Mark a line with `// hollowtest-ignore` to leave it alone.

It samples 30 mutants by default (`--max-mutants 100` for more, `--seed` to vary the sample). It is a quick probe, not a replacement for [Stryker](https://stryker-mutator.io/) on a whole codebase.

## Stop agents from writing hollow tests

**Claude Code plugin** (skill + hook):

```
/plugin install hollowtest --marketplace jeffev/hollowtest
```

The hook runs after every `Write`/`Edit` of a test file. If the agent just wrote a hollow test, the findings go straight back to it, and it fixes the test before moving on:

```
hollowtest: 1 hollow test problem(s) in math.test.js. These tests would pass even if the code were broken:
- line 3 "adds" [no-assertions] No assertions: this test passes as long as nothing throws.
```

That is a real transcript: the agent then rewrote the test as `assert.equal(add(1, 2), 3)` on its own. Set `HOLLOWTEST_HOOK=off` to pause it.

**Skill only**, for any project:

```bash
npx hollowtest --install-skill
```

This adds [`skills/hollowtest/SKILL.md`](skills/hollowtest/SKILL.md) to `.claude/skills/`, where Claude Code loads it whenever it writes or fixes tests, and prints a short `AGENTS.md` block for Codex, Cursor, Copilot and others. The skill is the contract:

- every test must fail if the behavior it names is broken;
- never make a red test green by skipping it, commenting out or weakening the assertion, mocking the module under test, or pasting the actual output into the expected value;
- run `npx hollowtest` on the tests you touched, and `--mutate` on important logic, before saying "tests pass".

## In CI

```bash
npx hollowtest --min-score 90        # fail below a score
npx hollowtest --fail-on error       # fail on any hollow test
npx hollowtest --changed --base origin/main   # only test files touched in this branch
npx hollowtest --json > report.json  # machine-readable
```

On GitHub Actions it emits annotations, so findings appear inline on the pull request:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npx hollowtest --fail-on error
```

## In your editor (ESLint)

```bash
npm i -D eslint-plugin-hollowtest
```

```js
// eslint.config.js
import hollowtest from 'eslint-plugin-hollowtest';
export default [hollowtest.configs.recommended];
```

Every rule shows up as `hollowtest/<rule>`, and `eslint --fix` applies the same safe fixes. See [`eslint-plugin/`](eslint-plugin/).

## Badge

```bash
npx hollowtest --badge
```

prints a Markdown badge with your score, like [![test integrity: 100/100 A](https://img.shields.io/badge/test_integrity-100%2F100%20A-brightgreen)](https://github.com/jeffev/hollowtest).

## How hollow are popular projects?

Well-maintained projects score high, as they should. The point is that even there, a few tests that cannot fail slip past review. These are real examples, not synthetic ones:

| Project | Tests | Score | Hollow | Weak |
|---|---:|---:|---:|---:|
| [express](https://github.com/expressjs/express/tree/1c6f1b0) | 1,159 | 100 | 0 | 1 |
| [date-fns](https://github.com/date-fns/date-fns/tree/a9739fb) | 2,900 | 100 | 6 | 0 |
| [ky](https://github.com/sindresorhus/ky/tree/3541888) | 1,285 | 100 | 0 | 11 |
| [TanStack Query](https://github.com/TanStack/query/tree/8be136b) | 4,818 | 100 | 0 | 12 |
| [axios](https://github.com/axios/axios/tree/9d11464) | 1,585 | 99 | 10 | 18 |
| [hono](https://github.com/honojs/hono/tree/17ad0e2) | 3,139 | 99 | 9 | 51 |
| [zustand](https://github.com/pmndrs/zustand/tree/382d29c) | 228 | 98 | 0 | 11 |
| [swr](https://github.com/vercel/swr/tree/8148ef0) | 411 | 96 | 13 | 4 |
| [nest](https://github.com/nestjs/nest/tree/8d9dd9d) | 7,406 | 95 | 100 | 572 |
| [zod](https://github.com/colinhacks/zod/tree/2554b70) | 2,693 | 93 | 134 | 245 |

And in Python:

| Project | Tests | Score | Hollow | Weak |
|---|---:|---:|---:|---:|
| [fastapi](https://github.com/fastapi/fastapi/tree/45cb225) | 2,745 | 99 | 14 | 10 |
| [flask](https://github.com/pallets/flask/tree/49943b5) | 372 | 99 | 2 | 1 |
| [httpx](https://github.com/encode/httpx/tree/b5addb6) | 539 | 99 | 4 | 5 |
| [click](https://github.com/pallets/click/tree/2247b35) | 606 | 98 | 3 | 17 |
| [rich](https://github.com/Textualize/rich/tree/9d8f9a3) | 694 | 97 | 18 | 10 |
| [pydantic](https://github.com/pydantic/pydantic/tree/132df97) | 4,306 | 97 | 68 | 96 |
| [requests](https://github.com/psf/requests/tree/3c7baaa) | 347 | 95 | 10 | 16 |
| [attrs](https://github.com/python-attrs/attrs/tree/c8bb9bf) | 667 | 93 | 26 | 35 |

A few of the findings:

- zod, [`number.test.ts:103`](https://github.com/colinhacks/zod/blob/2554b70/packages/zod/src/v3/tests/number.test.ts#L103): `expect(z.number().minValue).toBeNull;`. The matcher is never called, so the six lines in that test assert nothing.
- zod, [`tuple.test.ts:9`](https://github.com/colinhacks/zod/blob/2554b70/packages/zod/src/v4/classic/tests/tuple.test.ts#L9): `expect(val).toEqual(val)`.
- zod, [`error.test.ts:492`](https://github.com/colinhacks/zod/blob/2554b70/packages/zod/src/v3/tests/error.test.ts#L492): the expected error is asserted inside `catch`. If `parse` stopped throwing, the test would still pass. The same pattern appears in 53 zod tests.
- swr, [`use-swr-local-mutation.test.tsx:320`](https://github.com/vercel/swr/blob/8148ef0/test/use-swr-local-mutation.test.tsx#L320): `expect(...).resolves.toBe('data')` without `await`. The test ends before the assertion runs.
- nest, [`client-kafka.spec.ts:946`](https://github.com/nestjs/nest/blob/8d9dd9d/packages/microservices/test/client/client-kafka.spec.ts#L946): `.catch(err => expect(err)...)` on a promise the test never awaits.

- requests, [`test_requests.py:2538`](https://github.com/psf/requests/blob/3c7baaa/tests/test_requests.py#L2538): the timeout message is asserted inside `except Timeout`. If the request stopped timing out, the test would pass.
- flask, [`test_basic.py:1631`](https://github.com/pallets/flask/blob/49943b5/tests/test_basic.py#L1631): the mock records `passthrough_errors` into `rv`, and nothing ever reads `rv`.

Most of nest's "weak" tests are the `it('should be defined', () => expect(service).toBeDefined())` stubs generated by its CLI. Reproduce any row with `npx hollowtest` at the linked commit.

## Score

Each test counts 1 if clean, 0.5 if its worst finding is a warning, 0.9 for info, and 0 if hollow or skipped. Todo placeholders are not counted. The score is the average × 100. Grades: A ≥ 95, B ≥ 85, C ≥ 70, D ≥ 50, F below.

## Programmatic API

```js
import { analyzeProject, analyzeFile } from 'hollowtest';

const { summary, files } = analyzeProject(['src']);
console.log(summary.score, summary.hollow);
```

## Limits

- JavaScript, TypeScript and Python. `--mutate` is JavaScript/TypeScript only for now.
- Static analysis judges what it can see. A helper imported from a package it cannot read is reported as a warning, not an error.
- It does not run your tests unless you pass `--mutate`.

## License

MIT
