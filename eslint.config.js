import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";
import requireCliEnv from "./eslint-rules/require-cli-env.mjs";

export default [
  { ignores: ["node_modules/**", "dispatch/node_modules/**"] },
  {
    files: ["**/*.mjs", "**/*.js", "**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      // A leading underscore marks a binding kept for its position.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
    },
  },
  {
    // tsc checks names and unused bindings in TypeScript.
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser },
    rules: { "no-unused-vars": "off", "no-undef": "off", "no-redeclare": "off" },
  },
  {
    // Every `claude` CLI call the task spawns names the stored login's org
    // through `cliEnv`, so none depends on the CLI's profile fetch.
    files: ["dispatch/**/*.mjs"],
    plugins: { governor: { rules: { "require-cli-env": requireCliEnv } } },
    rules: { "governor/require-cli-env": "error" },
  },
];
