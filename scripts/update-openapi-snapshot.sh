#!/usr/bin/env bash
# Regenerate contract/openapi.snapshot.yaml from qurl-service.
#
# Usage:
#   scripts/update-openapi-snapshot.sh [ref]
#
# Default ref is `origin/main` in the local qurl-service checkout. Override
# with a tag/commit (e.g. `v1.2.3` or a SHA) to pin a specific snapshot.
#
# The script expects qurl-service checked out at ../qurl-service (sibling
# directory layout). If your layout differs, set QURL_SERVICE_DIR.

set -euo pipefail

QURL_SERVICE_DIR="${QURL_SERVICE_DIR:-$(cd "$(dirname "$0")/../.." && pwd)/qurl-service}"
REF="${1:-origin/main}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/contract/openapi.snapshot.yaml"

if [ ! -d "$QURL_SERVICE_DIR/.git" ]; then
  echo "error: $QURL_SERVICE_DIR is not a git checkout of qurl-service" >&2
  echo "       override with QURL_SERVICE_DIR=/path/to/qurl-service" >&2
  exit 2
fi

# Resolve ref → commit SHA so the snapshot header is deterministic even if
# the caller passed a branch name that moves later.
SHA=$(git -C "$QURL_SERVICE_DIR" rev-parse "$REF^{commit}")
SRC_FILE="api/openapi.yaml"

# Fetch the file at the resolved SHA (doesn't require checkout). Piping
# through cat keeps the script composable if someone redirects output.
CONTENT=$(git -C "$QURL_SERVICE_DIR" show "${SHA}:${SRC_FILE}")

{
  echo "# Snapshot of qurl-service/api/openapi.yaml — canonical API contract."
  echo "# This file is vendored (not auto-generated) so the contract test runs"
  echo "# hermetically without network or cross-repo checkout."
  echo "#"
  echo "# Source: layervai/qurl-service@${SHA}"
  echo "# Regenerate with: scripts/update-openapi-snapshot.sh"
  echo "#"
  printf '%s\n' "$CONTENT"
} > "$OUT"

echo "wrote $OUT (source: qurl-service@${SHA:0:12})"
