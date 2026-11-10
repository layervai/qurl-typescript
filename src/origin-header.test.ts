import { describe, it, expect } from "vitest";
import { createClient, mockFetch } from "./__tests__/test-helpers.js";
import { ValidationError } from "./errors.js";

const crid = "ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a";
const secret = "vercel-bypass-secret-0123456789ab";
const vercel = { name: "x-vercel-protection-bypass", value: secret };
const resource = {
  resource_id:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2cTVv5_3eeYCcLLq5ROYCqcmY50HiKZ9ATglIkPnCji1E_S63UMtXba1moR8-Q6EV7oM6zwwh9_j2CDujzXvLA",
  crid,
  target_url: "https://my-app.vercel.app",
  origin_header_name: "X-Vercel-Protection-Bypass",
};

function sentBody(fetch: ReturnType<typeof mockFetch>): Record<string, unknown> {
  const calls = (fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls;
  return JSON.parse(String(calls[0]![1]?.body)) as Record<string, unknown>;
}

describe("origin header", () => {
  it("protectUrl sends originHeader as origin_header", async () => {
    const fetch = mockFetch({ status: 201, body: { data: resource } });
    const handle = await createClient(fetch).protectUrl("https://my-app.vercel.app", {
      name: "Preview app",
      originHeader: vercel,
    });
    expect(handle.crid).toBe(crid);
    expect(sentBody(fetch)).toMatchObject({
      target_url: "https://my-app.vercel.app",
      origin_header: vercel,
    });
  });

  it("createResource passes origin_header through", async () => {
    const fetch = mockFetch({ status: 201, body: { data: resource } });
    const result = await createClient(fetch).createResource({
      target_url: "https://my-app.vercel.app",
      name: "Preview app",
      origin_header: vercel,
    });
    expect(sentBody(fetch).origin_header).toEqual(vercel);
    expect(result.origin_header_name).toBe("X-Vercel-Protection-Bypass");
  });

  it("updateResource rotates and clears with null", async () => {
    const rotate = mockFetch({ status: 200, body: { data: resource } });
    await createClient(rotate).updateResource(crid, { origin_header: { ...vercel, value: "new" } });
    expect(sentBody(rotate).origin_header).toEqual({ ...vercel, value: "new" });

    const clear = mockFetch({
      status: 200,
      body: { data: { ...resource, origin_header_name: undefined } },
    });
    await createClient(clear).updateResource(crid, { origin_header: null });
    expect(sentBody(clear)).toEqual({ origin_header: null });
  });

  it("treats null as omitted on create, per the SDK convention", async () => {
    const fetch = mockFetch({ status: 201, body: { data: resource } });
    await createClient(fetch).createResource({
      target_url: "https://my-app.vercel.app",
      name: "Preview app",
      origin_header: null as never,
    });
    expect(sentBody(fetch)).not.toHaveProperty("origin_header");
  });

  const badHeaders: [string, unknown][] = [
    ["reserved Host", { name: "Host", value: "x" }],
    ["reserved Cookie", { name: "cookie", value: "x" }],
    ["reserved X-Forwarded-For", { name: "X-Forwarded-For", value: "x" }],
    ["reserved X-Forwarded- prefix", { name: "X-Forwarded-Port", value: "x" }],
    ["reserved X-Qurl- prefix", { name: "x-qurl-anything", value: "x" }],
    ["reserved Content-Type", { name: "Content-Type", value: "x" }],
    ["reserved Via", { name: "via", value: "x" }],
    ["reserved Connection", { name: "Connection", value: "x" }],
    ["reserved Transfer-Encoding", { name: "Transfer-Encoding", value: "x" }],
    ["reserved Content-Length", { name: "content-length", value: "x" }],
    ["lowercase x-forwarded- prefix", { name: "x-forwarded-proto", value: "x" }],
    ["lowercase proxy- prefix", { name: "proxy-connection", value: "x" }],
    ["non-string name", { name: 1, value: "x" }],
    ["non-string value", { name: "X-Ok", value: 1 }],
    ["trailing tab", { name: "X-Ok", value: "a\t" }],
    ["multi-byte value over 4096 bytes", { name: "X-Ok", value: "\u00e9".repeat(2049) }],
    ["name over 256 chars", { name: "a".repeat(257), value: "x" }],
    ["proxy- prefix", { name: "Proxy-Authorization", value: "x" }],
    ["non-token name", { name: "bad name", value: "x" }],
    ["empty value", { name: "X-Ok", value: "" }],
    ["CRLF in value", { name: "X-Ok", value: "a\r\nInjected: 1" }],
    ["surrounding whitespace", { name: "X-Ok", value: " a" }],
    ["too long", { name: "X-Ok", value: "v".repeat(4097) }],
    ["unknown field", { name: "X-Ok", value: "v", extra: 1 }],
    ["not an object", "x-vercel-protection-bypass: secret"],
  ];
  it.each(badHeaders)("rejects %s before any request", async (_label, header) => {
    const fetch = mockFetch({ status: 201, body: { data: resource } });
    await expect(
      createClient(fetch).protectUrl("https://my-app.vercel.app", {
        originHeader: header as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never echoes the value in a validation error", async () => {
    const fetch = mockFetch({ status: 201, body: { data: resource } });
    const err = await createClient(fetch)
      .protectUrl("https://my-app.vercel.app", {
        originHeader: { name: "Host", value: secret },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(JSON.stringify(err)).not.toContain(secret);
    expect(String((err as Error).message)).not.toContain(secret);
  });

  it("allows Authorization for basic-auth or bearer origins", async () => {
    const fetch = mockFetch({ status: 201, body: { data: resource } });
    await createClient(fetch).protectUrl("https://my-app.vercel.app", {
      originHeader: { name: "Authorization", value: "Basic dXNlcjpwdw==" },
    });
    expect(sentBody(fetch).origin_header).toEqual({
      name: "Authorization",
      value: "Basic dXNlcjpwdw==",
    });
  });

  it("rejects invalid headers on createResource and updateResource too", async () => {
    const fetch = mockFetch({ status: 200, body: { data: resource } });
    const client = createClient(fetch);
    await expect(
      client.createResource({
        target_url: "https://my-app.vercel.app",
        origin_header: { name: "Host", value: "x" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.updateResource(crid, { origin_header: { name: "X-Ok", value: "a\nb" } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops a null originHeader on protectUrl, like other create fields", async () => {
    const fetch = mockFetch({ status: 201, body: { data: resource } });
    await createClient(fetch).protectUrl("https://my-app.vercel.app", {
      originHeader: null as never,
    });
    expect(sentBody(fetch)).not.toHaveProperty("origin_header");
  });

  const goodHeaders: [string, { name: string; value: string }][] = [
    ["a value of exactly 4096 bytes", { name: "X-Ok", value: "v".repeat(4096) }],
    ["a name of exactly 256 characters", { name: "a".repeat(256), value: "x" }],
    ["an inner tab and space", { name: "X-Ok", value: "a\tb c" }],
    // The service trims only space and tab, so other Unicode spaces are kept.
    ["a surrounding no-break space", { name: "X-Ok", value: "\u00a0a\u00a0" }],
  ];
  it.each(goodHeaders)("accepts %s", async (_label, header) => {
    const fetch = mockFetch({ status: 201, body: { data: resource } });
    await createClient(fetch).protectUrl("https://my-app.vercel.app", { originHeader: header });
    expect(sentBody(fetch).origin_header).toEqual(header);
  });

  it("clears the header alongside another field", async () => {
    const fetch = mockFetch({ status: 200, body: { data: resource } });
    await createClient(fetch).updateResource(crid, { origin_header: null, description: "x" });
    expect(sentBody(fetch)).toEqual({ origin_header: null, description: "x" });
  });

  it("never echoes the value when the value is what fails", async () => {
    const fetch = mockFetch({ status: 201, body: { data: resource } });
    const err = await createClient(fetch)
      .protectUrl("https://my-app.vercel.app", {
        originHeader: { name: "X-Ok", value: secret + "\r\n" },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(JSON.stringify(err)).not.toContain(secret);
    expect(String((err as Error).message)).not.toContain(secret);
  });
});
