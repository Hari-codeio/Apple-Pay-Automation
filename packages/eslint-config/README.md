# @apple-pay/eslint-config

Shared flat ESLint 9 config for every workspace package.

## Usage

```js
// <package>/eslint.config.mjs
import applePay from '@apple-pay/eslint-config';

export default applePay;
```

Add a package-scoped rule by appending a block — flat-config blocks are merged
in order, and later blocks win:

```js
import applePay from '@apple-pay/eslint-config';

export default [
  ...applePay,
  {
    files: ['src/payments/*.ts'],
    rules: {/* ... */},
  },
];
```

## What it enforces

| Concern         | Decision                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Baseline        | `typescript-eslint` recommended + `eslint-plugin-prettier` recommended. No base JS recommended preset. |
| Type-awareness  | Off. No `parserOptions.project`, so linting is fast and needs no per-package tsconfig wiring.          |
| Formatting      | Owned by Prettier via `prettier/prettier` (error). `endOfLine: 'auto'` tolerates CRLF and LF.          |
| Default exports | Banned, including `export { x as default }`. Every symbol carries one name at every import site.       |
| `export *`      | Banned except in a package entry-point barrel (`**/src/index.ts`).                                     |
| Unused vars     | Error, with an `^_` prefix escape hatch for deliberately-unused bindings.                              |
| Stale disables  | `reportUnusedDisableDirectives: 'warn'` — surfaced, never gating.                                      |

Rules that are deliberately **off**: `explicit-function-return-type`,
`explicit-module-boundary-types`, `no-explicit-any`.
