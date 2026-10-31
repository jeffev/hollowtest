# eslint-plugin-hollowtest

[hollowtest](https://github.com/jeffev/hollowtest)'s rules in your editor: tests with no assertions, `expect(x).toBe(x)`, `expect(x).toBeNull` without `()`, expects inside a `catch` that never runs, un-awaited `.resolves`, `.only` left behind, mocks of the module under test.

```bash
npm i -D eslint-plugin-hollowtest
```

```js
// eslint.config.js
import hollowtest from 'eslint-plugin-hollowtest';

export default [
  hollowtest.configs.recommended,
];
```

`eslint --fix` applies the same safe fixes as `npx hollowtest --fix`. ESLint 9+ (flat config). For TypeScript test files, use the parser your project already has (typescript-eslint); the rules read the source text, so any parser works.
