// @ts-check
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Shared flat ESLint config (ESLint 9) for Apple Pay Automation workspace
 * packages.
 *
 * The rule baseline is `tseslint.configs.recommended` + Prettier with node/jest
 * globals, plus the export-shape policy and linter options defined below. Two
 * deliberate properties:
 *   1. NON-type-aware. The active rule set needs no type information, so we omit
 *      `parserOptions.project`/`projectService`. That keeps linting fast and means
 *      there is no per-package tsconfig wiring to get wrong.
 *   2. No `eslint.configs.recommended` (base JS recommended): the rule set is
 *      TS-eslint + Prettier presets only.
 *
 * Consumers re-export this from their own `eslint.config.mjs`:
 *   import applePay from '@apple-pay/eslint-config';
 *   export default applePay;
 * Packages that need an extra rule append a scoped block:
 *   export default [...applePay, { files: ['src/x.ts'], rules: { ... } }];
 */

// EXPORT-SHAPE POLICY
// A symbol should carry exactly one name everywhere it appears — that is what
// makes find-by-text (rg / grep) tracing reliable. Default exports (in any
// syntactic form) let every import site invent its own name for the same
// symbol, and `export *` hides which symbols pass through a module from any
// text search.
//
// The selector arrays are shared between the base block and the scoped
// carve-out blocks below because flat-config rule options REPLACE rather than
// merge: each block must spell out its full restriction list. Add any new
// selector to these arrays, never inline in a single block, or the carve-out
// blocks will silently drop it.
const BAN_DEFAULT_EXPORT = [
  {
    selector: 'ExportDefaultDeclaration',
    message:
      'Use a named export. Default exports let each import site pick its own name for the symbol, which breaks text-search traceability.',
  },
  {
    selector: 'ExportSpecifier[exported.name="default"]',
    message:
      'Do not alias an export to `default` (`export { x as default }` / `export { default } from ...`) — it is a default export in disguise and breaks text-search traceability the same way.',
  },
];
const BAN_EXPORT_STAR = [
  {
    selector: 'ExportAllDeclaration',
    message:
      'Re-export by name. `export *` hides which symbols pass through this module from text search; wildcard re-exports are allowed only in package entry-point barrels (src/index.ts).',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.config.{js,cjs,mjs}',
    ],
  },
  ...tseslint.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      sourceType: 'module',
    },
    // A disable comment whose rule reports nothing in its range is stale — it
    // tells the reader a violation exists where none does. Note "reports
    // nothing" includes rules that are not enabled in this config at all, and
    // that `eslint --fix` deletes directives reported unused. 'warn', not
    // 'error', so surfacing them never gates anything on its own.
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // Allow intentionally-unused identifiers when prefixed with `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // endOfLine: 'auto' tolerates both CRLF and LF without flagging.
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  {
    // Export-shape policy (see EXPORT-SHAPE POLICY above). Scoped to
    // TypeScript sources: the carve-outs below are .ts-shaped, so an
    // unscoped ban would leave .js/.mjs files with no sanctioned escape.
    files: ['**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...BAN_DEFAULT_EXPORT,
        ...BAN_EXPORT_STAR,
      ],
    },
  },
  {
    // Package entry-point barrels: `export *` is the sanctioned shape for a
    // package's public surface. Deliberately NOT `**/index.ts` — a nested
    // sub-barrel (src/foo/index.ts) creates exactly the anonymous multi-hop
    // re-export chains the policy exists to prevent. Default exports stay
    // banned here.
    files: ['**/src/index.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...BAN_DEFAULT_EXPORT],
    },
  },
  {
    // Tool-mandated default exports: TypeScript config files (jest.config.ts
    // and friends) and Jest manual mocks of default-exporting modules must
    // export what their tool expects. Wildcard re-exports stay banned.
    files: ['**/*.config.ts', '**/__mocks__/**'],
    rules: {
      'no-restricted-syntax': ['error', ...BAN_EXPORT_STAR],
    },
  },
);
