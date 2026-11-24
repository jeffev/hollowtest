# Changelog

## 0.3.0 (2026-11-23)

- **`--mutate` for Python.** Mutates comparisons, arithmetic, `and`/`or`, `not`, booleans, numbers, `if` conditions and returns in `.py` files, runs the related tests with pytest (or unittest when pytest is missing) and restores the source. Related tests are found by following imports through your packages, so a test that imports `mypkg` still exercises `mypkg/core.py`.
- **Unreached vs. survived.** A mutant that slips through is now probed: its expression is replaced with one that throws. If the tests still pass, no test runs that code, and it is reported as `unreached` instead of `survived`. That separates "the tests run this but check nothing" from "nothing runs this at all". Works with any runner, no coverage setup. `--no-probe` skips it. The JSON output gains `unreached` per run and `status: "unreached"` per mutant; `survived` still counts every mutant that slipped through.
- **pre-commit hook.** Add `jeffev/hollowtest` to `.pre-commit-config.yaml` to block commits with hollow tests.
- **Safer runs.** `--mutate` stops when the runner finds no tests, instead of reporting every mutant as a survivor.

Both ideas came from readers of the launch post. Thanks to gautamtalksdev and vladzoff.

## 0.2.0 (2026-11-01)

- First public release on npm: static rules for JS, TS and Python, `--fix`, `--mutate` for JS/TS, GitHub annotations, Claude Code plugin, and `eslint-plugin-hollowtest` 0.1.0.
