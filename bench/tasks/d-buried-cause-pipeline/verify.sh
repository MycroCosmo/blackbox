#!/usr/bin/env bash
# Usage: verify.sh <workspace>
# Exit 0 only when the tax table actually loads. Tests are restored from the
# pristine task, and a hidden test covers regions the visible suite does not,
# so guarding the lookup or hardcoding the visible rates fails.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ws="$(cd "$1" && pwd)"

rm -rf "$ws/test"
cp -R "$here/project/test" "$ws/test"
cp "$here/hidden/hidden.test.ts" "$ws/test/hidden.test.ts"

cd "$ws"
npm test
