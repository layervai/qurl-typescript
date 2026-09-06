import { describe, expect, it } from "vitest";
import { parseStrictJson } from "./strict-json.js";

describe("strict native JSON", () => {
  it("rejects duplicate keys and trailing values", () => {
    expect(() => parseStrictJson(Buffer.from('{"x":1,"x":2}'), 100)).toThrow("duplicate");
    expect(() => parseStrictJson(Buffer.from('{"x":1}{}'), 100)).toThrow("trailing");
  });

  it("preserves uint64 integers without Number precision loss", () => {
    const parsed = parseStrictJson(Buffer.from('{"id":18446744073709551615}'), 100) as {
      id: bigint;
    };
    expect(parsed.id).toBe(18_446_744_073_709_551_615n);
  });

  it("keeps integer token syntax distinct from fractional and exponent forms", () => {
    const parsed = parseStrictJson(Buffer.from("[1,-0,1.0,1e0]"), 100) as [
      bigint,
      number,
      number,
      number,
    ];
    expect(parsed).toEqual([1n, -0, 1, 1]);
    expect(typeof parsed[0]).toBe("bigint");
    expect(typeof parsed[1]).toBe("number");
    expect(typeof parsed[2]).toBe("number");
    expect(typeof parsed[3]).toBe("number");
    expect(Object.is(parsed[1], -0)).toBe(true);
  });

  it("bounds bytes and nesting before materialization", () => {
    expect(() => parseStrictJson(Buffer.from("{}"), 1)).toThrow("byte limit");
    expect(() => parseStrictJson(Buffer.from("[".repeat(34) + "]".repeat(34)), 100)).toThrow(
      "nesting",
    );
  });

  it("scans numeric-heavy bounded documents without copying each remaining suffix", () => {
    const encoded = Buffer.from(`[${new Array(4_096).fill("18446744073709551615").join(",")}]`);
    const parsed = parseStrictJson(encoded, encoded.byteLength) as bigint[];
    expect(parsed).toHaveLength(4_096);
    expect(parsed[0]).toBe(18_446_744_073_709_551_615n);
    expect(parsed.at(-1)).toBe(18_446_744_073_709_551_615n);
  });
});
