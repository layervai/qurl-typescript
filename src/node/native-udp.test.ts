import { describe, expect, it } from "vitest";
import { nativeUdpTesting } from "./native-udp.js";

describe("native UDP DNS fence", () => {
  it.each([
    ["8.8.8.8", 4, true],
    ["127.0.0.1", 4, false],
    ["10.0.0.1", 4, false],
    ["169.254.169.254", 4, false],
    ["203.0.113.1", 4, false],
    ["2606:4700:4700::1111", 6, true],
    ["2001:4c00::1", 6, true],
    ["2001:4e00::1", 6, false],
    ["::1", 6, false],
    ["fc00::1", 6, false],
    ["2001:db8::1", 6, false],
  ] as const)("classifies %s", (address, family, accepted) => {
    expect(nativeUdpTesting.isPublicAddress(address, family)).toBe(accepted);
  });
});
