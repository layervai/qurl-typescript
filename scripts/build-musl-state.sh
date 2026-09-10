#!/usr/bin/env bash
set -euo pipefail
# Use the same pinned Alpine/Node image as the Discord consumer.
docker run --rm -v "$PWD:/work" -w /work \
  node:22.21.0-alpine3.22@sha256:bd26af08779f746650d95a2e4d653b0fd3c8030c44284b6b98d701c9b5eb66b9 \
  sh -ec 'apk add --no-cache build-base python3
    npm ci
    npm run prebuild --workspace @layervai/qurl-state-fs
    mv packages/state-fs/build "$(mktemp -d)/build"
    npm run build
    npm test -- src/node/file-agent-state.test.ts src/node/agent-runtime.test.ts'
