#!/usr/bin/env bash
# Vendoring discipline, mechanized: any staged change under src/vendor/*/src or a
# vendored bin.js must come with a src/vendor/README.md change in the same commit
# (the manifest's local-modification log is the contract — see src/vendor/README.md).
set -euo pipefail

staged=$(git diff --cached --name-only)

vendor_src_changed=$(echo "$staged" | grep -E '^src/vendor/[^/]+/(src/|bin\.js)' || true)
manifest_changed=$(echo "$staged" | grep -x 'src/vendor/README.md' || true)

if [[ -n "$vendor_src_changed" && -z "$manifest_changed" ]]; then
  echo 'vendor manifest guard: vendored SOURCE changed without updating src/vendor/README.md:'
  echo "$vendor_src_changed" | sed 's/^/  /'
  echo 'Log the modification in src/vendor/README.md ("Local modifications") and stage it.'
  exit 1
fi
