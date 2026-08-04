#!/usr/bin/env bash
# Pre-commit chart check: helm lint + helm-unittest against every env's values.
#
# Invoked by lint-staged when files under chart/ or deploy/ are staged. The
# staged filenames lint-staged passes are ignored on purpose — the checks run on
# the whole chart, not per file. Mirrors google-pay-automation.
set -euo pipefail

if ! command -v helm >/dev/null 2>&1; then
  echo "helm not found. Install it before committing chart changes." >&2
  echo "  https://helm.sh/docs/intro/install/" >&2
  exit 1
fi

if ! helm plugin list 2>/dev/null | grep -q '^unittest'; then
  echo "helm-unittest plugin missing. Install it with:" >&2
  # Same version CI pins (newer releases need helm >= 3.17).
  echo "  helm plugin install https://github.com/helm-unittest/helm-unittest --version 0.5.2" >&2
  exit 1
fi

# Lint and unit-test with each environment's values, so a schema violation or a
# broken template is caught for every env rather than only the default.
for env in staging preprod production; do
  echo "── helm lint (${env}) ──"
  helm lint ./chart -f "deploy/${env}/values.yaml"
  echo "── helm unittest (${env}) ──"
  helm unittest -v "deploy/${env}/values.yaml" chart
done
