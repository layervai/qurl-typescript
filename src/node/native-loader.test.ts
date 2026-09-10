import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it.each(["win32", "linux", "darwin"])(
  "checks %s before loading the optional native package",
  (platform) => {
    const native = { load: vi.fn(() => "native") };
    const require = vi.fn((name: string) => (name === "node:process" ? { platform } : native));
    const exports = {} as { loadNativeStateFS: () => unknown };
    runInNewContext(readFileSync(new URL("./native-loader.cjs", import.meta.url), "utf8"), {
      require,
      exports,
    });
    if (platform === "win32") {
      expect(() => exports.loadNativeStateFS()).toThrow("requires Linux or macOS");
      expect(native.load).not.toHaveBeenCalled();
      expect(require).toHaveBeenCalledTimes(1);
    } else {
      expect(exports.loadNativeStateFS()).toBe("native");
      expect(require).toHaveBeenCalledWith("@layervai/qurl-state-fs");
    }
  },
);
