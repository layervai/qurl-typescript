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

# Verify the remote actually points at qurl-service. Without this, someone
# with an unrelated repo at ../qurl-service that happens to contain
# api/openapi.yaml could silently snapshot from the wrong source — the
# header SHA would be from their fork, not upstream.
#
# Intentionally permissive: matches any org's `qurl-service` repo, not
# just layervai/qurl-service. Forks of qurl-service are legitimate dev
# workflows, and the header SHA recorded in the snapshot is the
# authoritative provenance that reviewers verify — this check exists to
# catch "wrong repo entirely," not to gate on upstream identity.
REMOTE_URL=$(git -C "$QURL_SERVICE_DIR" remote get-url origin 2>/dev/null || echo "")
if ! printf '%s' "$REMOTE_URL" | grep -q -E '[:/]qurl-service(\.git)?$'; then
  echo "error: $QURL_SERVICE_DIR origin remote does not look like qurl-service:" >&2
  echo "       $REMOTE_URL" >&2
  echo "       expected a URL ending in :qurl-service or /qurl-service(.git)" >&2
  exit 2
fi

# Refresh remote refs so `origin/main` (the default) points at the current
# upstream tip, not whatever was last fetched locally. Without this, a
# stale checkout would silently pin the snapshot to an old SHA. Harmless
# when the caller passes an explicit SHA or tag.
git -C "$QURL_SERVICE_DIR" fetch --quiet origin

# Resolve ref → commit SHA so the snapshot header is deterministic even if
# the caller passed a branch name that moves later.
SHA=$(git -C "$QURL_SERVICE_DIR" rev-parse "$REF^{commit}")
SRC_FILE="api/openapi.yaml"

# Preflight: confirm the spec file actually exists at that SHA. Without
# this, a missing/renamed SRC_FILE surfaces as a bare `git show` error
# mid-pipeline — clear-up-front message is friendlier to the operator.
if ! git -C "$QURL_SERVICE_DIR" cat-file -e "${SHA}:${SRC_FILE}" 2>/dev/null; then
  echo "error: ${SRC_FILE} not found at qurl-service@${SHA:0:12}" >&2
  echo "       has the spec moved in qurl-service? update SRC_FILE in $0" >&2
  exit 2
fi

# Write to a sibling tempfile and `mv` into place so a Ctrl-C mid-write
# can't leave the committed snapshot truncated. `mv` on the same
# filesystem is atomic; the trap cleans up the tempfile if the script
# aborts before the rename. Streaming `git show` directly into the
# heredoc (rather than capturing into a shell variable) avoids trailing-
# newline truncation and ARG_MAX/memory edges on very large specs.
TMP=$(mktemp "${OUT}.tmp.XXXXXX")
trap 'rm -f "$TMP"' EXIT
{
  echo "# Snapshot of qurl-service/api/openapi.yaml — canonical API contract."
  echo "# This file is vendored (not auto-generated) so the contract test runs"
  echo "# hermetically without network or cross-repo checkout."
  echo "#"
  echo "# Source: layervai/qurl-service@${SHA}"
  echo "# Regenerate with: scripts/update-openapi-snapshot.sh"
  echo "#"
  git -C "$QURL_SERVICE_DIR" show "${SHA}:${SRC_FILE}"
} > "$TMP"
mv "$TMP" "$OUT"

echo "wrote $OUT (source: qurl-service@${SHA:0:12})"
