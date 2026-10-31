---
name: hollowtest
description: Write tests that actually fail when the code is wrong, and never make a red test green by weakening it. Use whenever you write, change, fix, or review tests (Jest, Vitest, Mocha, node:test, Playwright, Testing Library), when asked to "add tests", "increase coverage", or "make the tests pass", and before reporting that tests pass.
---

# hollowtest: no hollow tests

A hollow test passes no matter what the code does. It turns coverage green and proves nothing. People write them in a hurry, and an agent asked to "make the tests pass" can be tempted to. This skill is the contract against it, and `npx hollowtest` is the check that enforces it.

## The rule

**Every test must fail if the behavior it names is broken.** Before you finish a test, ask: "If I deleted the body of the function under test, or flipped its main condition, would this test fail?" If the answer is no, the test is hollow.

## Never do these to make a test pass

These are the moves that turn a failing test into a hollow one. If you catch yourself about to do one, stop and fix the code instead, or tell the user the test exposed a bug.

1. **Do not skip or focus.** No `it.skip`, `xit`, `test.todo` as a replacement, `describe.skip`, and never leave `.only` behind (it silently disables every other test in the file).
2. **Do not comment out or delete the failing assertion.**
3. **Do not weaken the assertion.** Replacing `toBe(42)` with `toBeDefined()`, `toBeTruthy()`, `not.toBeNull()`, `toBeGreaterThan(0)` or a bare `toHaveBeenCalled()` is weakening.
4. **Do not copy the actual output into the expected value** without checking that the output is correct. If the code returns the wrong thing, the test was right.
5. **Do not mock the module under test.** `cart.test.ts` must not `vi.mock('./cart')` / `jest.mock('./cart')`. Mock the boundaries (network, clock, filesystem, other modules), never the subject.
6. **Do not regenerate snapshots** (`-u`) to get past a failure you have not read and understood.
7. **Do not wrap assertions in `try/catch`** that swallows the error.

## Write assertions that can fail

- Assert on the **actual value**: `expect(total(cart)).toBe(35)`, not `expect(total(cart)).toBeDefined()`.
- Interaction tests check **arguments**: `toHaveBeenCalledWith(...)`, not only `toHaveBeenCalled()`.
- Errors: `expect(() => parse('')).toThrow('empty')` or `await expect(load()).rejects.toThrow(...)`. Not `try { parse('') } catch (e) { expect(e)... }`: that passes when nothing throws. If you must use try/catch, add `expect.assertions(n)`.
- **Await async assertions**: `await expect(p).resolves.toEqual(...)`. Return or await any promise whose `.then()` contains an `expect`.
- No assertion only behind an `if` or inside a loop over data that might be empty. Assert the length first.
- No tautologies: `expect(x).toBe(x)`, `expect(true).toBe(true)`.
- Each test covers the **edge that matters**: boundaries (`>=` vs `>`), empty input, the error path. One happy-path call is not a test of a function with branches.

## Check your work

After writing or changing tests, run:

```bash
npx hollowtest <the test files or folder you touched>
```

Fix every `error`. Treat `warn` as a reason to strengthen the test unless it is a deliberate smoke test. Do not report "tests pass" while hollowtest reports errors in tests you wrote.

For important logic, verify that the tests catch real breakage:

```bash
npx hollowtest --mutate <the source file you tested>
```

Each **survivor** is a change to the code (`>` became `>=`, `&&` became `||`, a condition forced to `true`) that no test noticed. Add an assertion that fails for it, then run again.

## When a test fails

A failing test is information. Decide which side is wrong:

- **The code is wrong**: fix the code. The test stays.
- **The test is wrong** (the requirement changed, or the test asserted something incorrect): change the test and say why in your reply.
- **You are not sure**: do not guess by editing the expected value. Tell the user what the test expects, what the code does, and ask.
