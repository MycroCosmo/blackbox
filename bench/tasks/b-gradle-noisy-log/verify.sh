#!/usr/bin/env bash
# Usage: verify.sh <workspace>
# Exit 0 only when the configuration value itself was fixed. Tests are restored
# from the pristine task, and a hidden test pins the bound VAT rate to 0.10 so
# changing the property type or hard-coding the rate in Java does not pass.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ws="$(cd "$1" && pwd)"

rm -rf "$ws/src/test"
cp -R "$here/project/src/test" "$ws/src/test"
cp -R "$here/hidden/." "$ws/src/test/java/"

cd "$ws"
./gradlew test --console=plain --quiet
