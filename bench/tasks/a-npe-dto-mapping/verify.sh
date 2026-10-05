#!/usr/bin/env bash
# Usage: verify.sh <workspace>
# Exit 0 only when the agent fixed the real cause (the DTO mapping).
# Test files are restored from the pristine task first, so editing or deleting
# tests cannot make this pass, and a hidden mapping test rejects fixes that only
# add a null guard downstream.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ws="$(cd "$1" && pwd)"

rm -rf "$ws/src/test"
cp -R "$here/project/src/test" "$ws/src/test"
cp -R "$here/hidden/." "$ws/src/test/java/"

cd "$ws"
./gradlew test --console=plain --quiet
