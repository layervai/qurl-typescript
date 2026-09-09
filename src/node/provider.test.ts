import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createDiscoveryProvider,
  createStaticProvider,
  createHTTPManifestFetcher,
} from "./provider.js";
import { createPortalOpener } from "./portal-opener.js";
import { validateRelayURL, readBoundedBody } from "./relay.js";
import { createMatchedQv2Fixture } from "../__tests__/matched-qv2-fixture.js";

const fixture = createMatchedQv2Fixture();
const manifest = {
  profile: "test",
  version: 2,
  issued_at: 1000,
  not_after: 2000,
  issuers: [fixture.issuer],
  relay_allowlist: ["relay.example.test"],
};
const bytes = Buffer.from(JSON.stringify(manifest));
const envelope = (value = bytes, signature?: Buffer) =>
  Buffer.from(
    JSON.stringify({
      manifest_b64: value.toString("base64url"),
      sig_b64: signature?.toString("base64url"),
      kid: "signer",
    }),
  );
const pin = createHash("sha256").update(bytes).digest();

describe("discovery and explicit transport", () => {
  it("authenticates exact bytes, enforces expiry and never serves stale trust", async () => {
    let now = 2_000_000;
    const fetcher = vi.fn(async () => envelope());
    const provider = createDiscoveryProvider({ fetcher, pinSHA256: pin, now: () => now });
    expect((await provider.resolve()).issuers).toEqual([fixture.issuer]);
    now += 1000;
    await expect(provider.resolve()).rejects.toThrow("expired");
    fetcher.mockRejectedValueOnce(new Error("offline"));
    await expect(provider.resolve()).rejects.toThrow("offline");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects a changed pin, a future window, and an unknown field", async () => {
    const resolve = (value: object, expectedPin?: Buffer) => {
      const raw = Buffer.from(JSON.stringify(value));
      return createDiscoveryProvider({
        fetcher: async () => envelope(raw),
        pinSHA256: expectedPin ?? createHash("sha256").update(raw).digest(),
        now: () => 1_000_000,
      }).resolve();
    };
    await expect(resolve({ ...manifest, version: 3 }, pin)).rejects.toThrow("pin mismatch");
    await expect(resolve({ ...manifest, issued_at: 1121 })).rejects.toThrow("not yet valid");
    await expect(resolve({ ...manifest, cells: [] })).rejects.toThrow("schema");
  });

  it("verifies low-S domain-separated signatures and rejects downgrade", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const signed = (version: number, domain = "NHP-QURL-V2-DISCOVERY-MANIFEST\0") => {
      const raw = Buffer.from(JSON.stringify({ ...manifest, version }));
      const signature = sign("sha256", Buffer.concat([Buffer.from(domain), raw]), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      });
      const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
      const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
      if (s > order / 2n)
        Buffer.from((order - s).toString(16).padStart(64, "0"), "hex").copy(signature, 32);
      return envelope(raw, signature);
    };
    let raw = signed(3);
    const provider = createDiscoveryProvider({
      fetcher: async () => raw,
      manifestKeys: new Map([["signer", publicKey]]),
      requireSignature: true,
      now: () => 1_000_000,
    });
    await provider.resolve();
    raw = signed(2);
    await expect(provider.resolve()).rejects.toThrow("downgrade");
    raw = signed(4, "NHP-QURL-V2-ISSUER\0");
    await expect(provider.resolve()).rejects.toThrow("signature");
  });

  it("does not use relay for an unknown cell in default native mode", async () => {
    const relayFetch = vi.fn();
    const provider = createStaticProvider({
      issuers: [fixture.issuer],
      cells: [],
      relay_allowlist: ["relay.example.test"],
    });
    const opener = createPortalOpener({ qurl: fixture.qurl, provider, relayFetch });
    try {
      await expect(opener.start()).rejects.toThrow("outside the native catalog");
    } finally {
      await opener.close();
    }
    expect(relayFetch).not.toHaveBeenCalled();
  });

  it("bounds discovery HTTP, refuses redirects and untrusted relay origins", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    await createHTTPManifestFetcher("https://trust.example.test/manifest", fetch)();
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    expect(() => createHTTPManifestFetcher("http://trust.example.test")).toThrow();
    expect(() => validateRelayURL("https://bad.example.test", ["relay.example.test"])).toThrow();
    expect(() =>
      validateRelayURL("https://user@relay.example.test", ["relay.example.test"]),
    ).toThrow();
    expect(
      validateRelayURL("https://relay.example.test:8443/base", ["relay.example.test"]).port,
    ).toBe("8443");
    await expect(readBoundedBody(new Response("oversize"), 3)).rejects.toThrow("size limit");
  });
});
