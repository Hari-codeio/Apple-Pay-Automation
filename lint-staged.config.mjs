// Root lint-staged config: lint + auto-fix staged TypeScript, per workspace
// package, with ESLint invoked IN that package's directory.
//
// Why per-package cwd: ESLint 9 resolves `eslint.config.mjs` relative to cwd,
// so a single ESLint run from the repo root would lint every package under
// whichever config it happened to find first. `pnpm -C <pkg> exec` re-roots cwd
// so each package lints under its own config (which is where per-package rule
// carve-outs live).
import path from 'node:path';

const root = process.cwd();

// Workspace packages that ship an `eslint.config.mjs` and a `lint` script.
// Keep in sync with pnpm-workspace.yaml. `packages/eslint-config` is absent on
// purpose: it holds no TypeScript, only the shared flat config itself.
const LINTABLE = new Set(['api', 'packages/config-validation']);

// Each package's `lint` script targets `{src,test}/**/*.ts`. Restrict to those
// roots so ESLint is never handed a file outside the package's lint scope.
const LINT_ROOTS = ['src/', 'test/'];

function packageOf(absFile) {
  const segs = path.relative(root, absFile).split(path.sep);
  const candidate =
    segs[0] === 'packages' && segs.length > 1 ? `packages/${segs[1]}` : segs[0];
  return LINTABLE.has(candidate) ? candidate : null;
}

export default {
  '**/*.ts': (files) => {
    const byPackage = new Map();
    for (const file of files) {
      if (file.endsWith('.d.ts')) continue;
      const pkg = packageOf(file);
      if (!pkg) continue; // root-level or non-lintable file — skip
      // Normalize to forward slashes: on Windows path.relative() returns
      // backslash-separated paths, which would fail the forward-slash
      // LINT_ROOTS check below and silently skip the file. ESLint accepts
      // forward-slash paths on every platform.
      const rel = path
        .relative(path.join(root, pkg), file)
        .split(path.sep)
        .join('/');
      if (!LINT_ROOTS.some((r) => rel.startsWith(r))) continue;
      if (!byPackage.has(pkg)) byPackage.set(pkg, []);
      byPackage.get(pkg).push(rel);
    }
    return [...byPackage].map(
      ([pkg, rels]) =>
        `pnpm -C ${pkg} exec eslint --fix ${rels
          .map((r) => JSON.stringify(r))
          .join(' ')}`,
    );
  },
  // Non-TypeScript sources get formatted only — ESLint does not own them.
  '**/*.{json,md,yaml,yml,mjs,cjs,js}': ['prettier --write'],

  // Chart changes run helm lint + helm-unittest against EVERY environment's
  // values, so a schema violation or broken template cannot reach a cluster.
  // The staged filenames are ignored on purpose — the checks are whole-chart,
  // not per-file, which is why this is a function returning one command.
  //
  // Requires helm + the helm-unittest plugin locally; the script exits with
  // install instructions if either is missing.
  '{chart,deploy}/**/*': () => ['bash scripts/helm-precommit.sh'],
};
