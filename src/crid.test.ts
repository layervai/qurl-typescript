import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { parseCrid, cridKeyMatches } from "./crid.js";

const require = createRequire(import.meta.url);
const vectors = JSON.parse(
  readFileSync(require.resolve("@layervai/qurl-conformance/crid_v1_vectors.json"), "utf8"),
) as {
  producer_cases: { name: string; expected_crid: string; der_spki_b64url: string }[];
  consumer_value_cases: { name: string; value: string; outcome: string }[];
  key_match_cases: { name: string; crid: string; der_spki_b64url: string; outcome: string }[];
};
it.each(vectors.consumer_value_cases)("CRID local gate: $name", ({ value, outcome }) => {
  const digest = parseCrid(value);
  expect(digest !== undefined).toBe(outcome === "accept");
  if (digest) expect(digest.length).toBe(value.length === 47 ? 24 : 32);
});
it.each(vectors.key_match_cases)(
  "CRID key binding: $name",
  async ({ crid, der_spki_b64url, outcome }) => {
    expect(await cridKeyMatches(crid, Buffer.from(der_spki_b64url, "base64url"))).toBe(
      outcome === "match",
    );
  },
);

it.each(vectors.producer_cases)(
  "CRID producer key binding: $name",
  async ({ expected_crid, der_spki_b64url }) => {
    expect(await cridKeyMatches(expected_crid, Buffer.from(der_spki_b64url, "base64url"))).toBe(
      true,
    );
    expect(await cridKeyMatches(expected_crid, new Uint8Array())).toBe(false);
  },
);
it.each(vectors.consumer_value_cases.filter(({ name }) => name.startsWith("accept_unknown")))(
  "unknown CRID versions retain the Go key-match rule: $name",
  async ({ value }) => {
    expect(
      await cridKeyMatches(
        value,
        Buffer.from(vectors.producer_cases[0].der_spki_b64url, "base64url"),
      ),
    ).toBe(true);
  },
);
