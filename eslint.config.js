import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
};

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "data/**", ".sandbox/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["scripts/**/*.mjs", "*.js"], languageOptions: { globals: nodeGlobals } },
  // the UI walkthrough also runs callbacks inside the browser page
  { files: ["web/scripts/**/*.mjs"], languageOptions: { globals: { ...nodeGlobals, document: "readonly", window: "readonly", fetch: "readonly", getComputedStyle: "readonly", sessionStorage: "readonly", localStorage: "readonly" } } },
);
