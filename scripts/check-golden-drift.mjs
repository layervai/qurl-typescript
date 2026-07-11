// Cross-repo drift fence for the vendored NHP agent-registration golden vectors.
//
// WHY: `src/crypto/__testdata__/agent_registration_golden.json` is a
// byte-identical *temporary vendor* of the canonical
// `layervai/qurl-conformance` artifact `vectors/agent_registration_golden.json`
// (see that file's __testdata__/README.md). `crypto/golden.test.ts` already pins
// the vendored file's SHA-256 so a *local* edit can't silently turn the
// cross-language fence back into a self-consistency check — but that pin cannot
// notice the *canonical upstream* changing. This script closes that gap: it
// fetches the canonical file and asserts the vendored copy is byte-for-byte
// identical, so the two cannot silently diverge while we wait on the published
// `@layervai/qurl-conformance` accessor (tracked in layervai/qurl-typescript#176).
//
// WHAT RUNS THIS: the `golden-drift` CI job (.github/workflows/ci.yml). It is a
// network fetch, so it is a CI step, deliberately NOT part of `vitest` — the unit
// suite stays hermetic and offline-runnable. Run locally with:
//   CONFORMANCE_REF=<ref> GITHUB_TOKEN=<token> node scripts/check-golden-drift.mjs
//
// ── AT-PUBLISH RE-POINT ────────────────────────────────────────────────────────
// The canonical vectors currently live on the qurl-conformance PR branch
// (layervai/qurl-conformance#20), not yet on the default branch, and the npm
// package (@layervai/qurl-conformance) does not yet expose them. Until that PR
// merges, DEFAULT_REFS resolves the PR branch first and falls back to `main`, so
// this fence keeps working the moment #20 merges with no code change. Once #20
// merges you can drop the PR-branch entry and keep only "main" (TODO(#176) below).
// Once the npm package publishes an `agentRegistrationVectors()` accessor, this
// whole script + the vendored fixture are retired in favour of the accessor — see
// the matching TODO(#176) in `src/crypto/golden.test.ts`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const VENDORED_PATH = fileURLToPath(
  new URL("../src/crypto/__testdata__/agent_registration_golden.json", import.meta.url),
);

const CANONICAL_REPO = "layervai/qurl-conformance";
const CANONICAL_PATH = "vectors/agent_registration_golden.json";

// The refs to try, in order, taking the first that resolves. The canonical file
// currently lives ONLY on the qurl-conformance PR branch
// (layervai/qurl-conformance#20); `main` is listed second so the fence keeps
// working the moment that PR merges (and the PR branch is deleted) with no code
// change. Override with CONFORMANCE_REF to pin a single ref (e.g. a SHA/tag) for a
// reproducible check.
//
// TODO(#176): once #20 merges, drop "justin/agent-registration-vectors" and keep
// only "main". Once @layervai/qurl-conformance publishes the accessor, retire this
// script entirely (see the matching TODO in src/crypto/golden.test.ts).
const DEFAULT_REFS = ["justin/agent-registration-vectors", "main"];
const refsToTry = process.env.CONFORMANCE_REF?.trim()
  ? [process.env.CONFORMANCE_REF.trim()]
  : DEFAULT_REFS;

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Fetch the canonical file at one ref via the GitHub contents API (works for a
 * branch, tag, or SHA; the repo is public so no token is required, but one is
 * used if present to lift the anonymous rate limit). Returns the raw bytes, or
 * null on 404 (ref/file absent) so the caller can try the next ref. */
async function fetchCanonicalAt(ref) {
  const url = `https://api.github.com/repos/${CANONICAL_REPO}/contents/${CANONICAL_PATH}?ref=${encodeURIComponent(ref)}`;
  const headers = {
    Accept: "application/vnd.github.raw+json",
    "User-Agent": "qurl-typescript-golden-drift-check",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { headers });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `fetching canonical vectors from ${CANONICAL_REPO}@${ref} failed: HTTP ${res.status} ${res.statusText}. Body: ${body.slice(0, 200)}`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Try each candidate ref in order; return { ref, bytes } for the first that
 * resolves, or throw if none do. */
async function fetchCanonical() {
  for (const ref of refsToTry) {
    const bytes = await fetchCanonicalAt(ref);
    if (bytes !== null) {
      return { ref, bytes };
    }
  }
  throw new Error(
    `canonical ${CANONICAL_PATH} not found at ${CANONICAL_REPO} on any of: ${refsToTry.join(", ")} (all HTTP 404). ` +
      `The vectors may not be published yet, or the ref list is stale — see TODO(#176) in this script.`,
  );
}

async function main() {
  let vendored;
  try {
    vendored = readFileSync(VENDORED_PATH);
  } catch (err) {
    console.error(`✗ could not read the vendored fixture at ${VENDORED_PATH}: ${err.message}`);
    process.exit(1);
  }

  let canonical, resolvedRef;
  try {
    const fetched = await fetchCanonical();
    canonical = fetched.bytes;
    resolvedRef = fetched.ref;
  } catch (err) {
    console.error(`✗ golden drift check could not fetch the canonical vectors: ${err.message}`);
    process.exit(1);
  }

  const vendoredSha = sha256(vendored);
  const canonicalSha = sha256(canonical);

  if (vendored.equals(canonical)) {
    console.log(
      `✓ vendored agent-registration golden vectors match ${CANONICAL_REPO}@${resolvedRef} ` +
        `(sha256=${vendoredSha}, ${vendored.length} bytes)`,
    );
    return;
  }

  console.error("✗ vendored agent-registration golden vectors have DRIFTED from canonical.");
  console.error(`    vendored : ${VENDORED_PATH}`);
  console.error(`               sha256=${vendoredSha} (${vendored.length} bytes)`);
  console.error(`    canonical: ${CANONICAL_REPO}@${resolvedRef}:${CANONICAL_PATH}`);
  console.error(`               sha256=${canonicalSha} (${canonical.length} bytes)`);
  console.error(
    "    Re-vendor the canonical file verbatim (do not hand-edit) and update FIXTURE_SHA256 " +
      "in src/crypto/golden.test.ts to the new digest. If the change is unexpected, investigate " +
      "the upstream edit before syncing.",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(`✗ golden drift check crashed: ${err.stack ?? err}`);
  process.exit(1);
});
