import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@layervai/qurl/node": fileURLToPath(new URL("./src/node.ts", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts", "packages/**/*.test.ts"],
    unstubGlobals: true,
  },
});
