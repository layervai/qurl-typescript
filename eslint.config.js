import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        Response: "readonly",
        Request: "readonly",
        ReadableStream: "readonly",
        Headers: "readonly",
        AbortSignal: "readonly",
        AbortController: "readonly",
        DOMException: "readonly",
        RequestInit: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        // Web/Node globals used by the native NHP crypto and registration wire.
        crypto: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        DataView: "readonly",
        Uint8Array: "readonly",
        ArrayBuffer: "readonly",
        Buffer: "readonly",
        Blob: "readonly",
        FormData: "readonly",
        NodeJS: "readonly",
        DecompressionStream: "readonly",
        btoa: "readonly",
        atob: "readonly",
        structuredClone: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "no-console": ["error", { allow: ["error", "warn", "debug"] }],
      eqeqeq: ["error", "always"],
      "no-throw-literal": "error",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "*.config.js"],
  },
];
