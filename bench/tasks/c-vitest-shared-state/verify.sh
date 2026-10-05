#!/usr/bin/env bash
# Usage: verify.sh <workspace>
# Exit 0 only when shared state no longer leaks between calls. Tests are
# restored from the pristine task, and a hidden test calls the formatter in an
# order the visible suite does not, so patching a single call site fails.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ws="$(cd "$1" && pwd)"

rm -rf "$ws/test"
cp -R "$here/project/test" "$ws/test"
cp "$here/hidden/hidden.test.ts" "$ws/test/hidden.test.ts"

cd "$ws"
npx vitest run
