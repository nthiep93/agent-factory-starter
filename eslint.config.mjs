import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // holdout/ is hidden from agents' lint; CI lints it with --no-ignore in the holdout job.
    ignores: [
      "**/dist/**",
      // Other agents' worktrees: never lint another checkout from this one.
      ".claude/worktrees/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/next-env.d.ts",
      ".turbo/**",
      "holdout/**",
    ],
  },
  js.configs.recommended,
  {
    // Node scripts and holdout scenarios (node:test + fetch, no dependencies).
    files: ["scripts/**/*.mjs", "holdout/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        URL: "readonly",
      },
    },
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
