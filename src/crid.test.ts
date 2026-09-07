import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { parseCrid, cridKeyMatches } from "./crid.js";

const require = createRequire(import.meta.url);
const vectors = JSON.parse(
  readFileSync(require.resolve("@layervai/qurl-conformance/crid_v1_vectors.json"), "utf8"),
) as {
  consumer_value_cases: { name: string; value: string; outcome: string }[];
  key_match_cases: { name: string; crid: string; der_spki_b64url: string; outcome: string }[];
};
it.each(vectors.consumer_value_cases)("CRID local gate: $name", ({ value, outcome }) => {
  expect(parseCrid(value) !== undefined).toBe(outcome === "accept");
});
it.each(vectors.key_match_cases)(
  "CRID key binding: $name",
  async ({ crid, der_spki_b64url, outcome }) => {
    expect(await cridKeyMatches(crid, Buffer.from(der_spki_b64url, "base64url"))).toBe(
      outcome === "match",
    );
  },
);
