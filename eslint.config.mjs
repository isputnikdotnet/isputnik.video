// Lint: `npm run lint`. tsc --strict does the heavy lifting; this catches what
// the compiler can't — dead variables, stray `any`. Same rule set as
// isputnik.home and isputnik.games, so a file moved between them lints the same.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  { ignores: ["**/dist/**", "**/node_modules/**", "data/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "none",
        ignoreRestSiblings: true
      }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-useless-assignment": "off",
      "no-useless-escape": "warn"
    }
  },
  {
    files: ["**/*.{ts,js,mjs}"],
    languageOptions: { globals: globals.node }
  }
);
