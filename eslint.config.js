import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";
import requireCliEnv from "./eslint-rules/require-cli-env.mjs";
import noDynamicReadinessChecks from "./eslint-rules/no-dynamic-readiness-checks.mjs";

// Only scripts/lib/ready-work.mjs combines the readiness checks, through
// `ticketStatus` (docs/constraints/dispatcher-repos.md). A caller elsewhere
// asks it, `mayPickUp` or `mayStartSpec`, so no path puts the checks
// together in its own order.
const READINESS_CHECKS = ["isBlocked", "isWaiting", "waitHolds", "heldUnreadied", "labelRow"];
const refuseChecks = (allowed) => [
  "error",
  {
    patterns: [
      {
        group: ["**/ready-work.mjs"],
        importNames: READINESS_CHECKS.filter((name) => name !== allowed),
        message: "Ask ticketStatus, mayPickUp or mayStartSpec in scripts/lib/ready-work.mjs instead of combining the readiness checks here.",
      },
    ],
  },
];
// `no-restricted-imports` reads no names from `import()`, so a dynamic
// import of ready-work.mjs answers to its own rule, with the same checks.
const refuseDynamicChecks = (allowed) => [
  "error",
  { checks: READINESS_CHECKS, ...(allowed === undefined ? {} : { allowed }) },
];

export default [
  // The copied parser is kept unchanged (dispatch/webhook/vendor/README.md),
  // and names rules this config does not load.
  { ignores: ["node_modules/**", "dispatch/node_modules/**", "dispatch/webhook/vendor/**"] },
  {
    files: ["**/*.mjs", "**/*.js", "**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    plugins: {
      governor: { rules: { "require-cli-env": requireCliEnv, "no-dynamic-readiness-checks": noDynamicReadinessChecks } },
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
    rules: { "governor/require-cli-env": "error" },
  },
  {
    // Tests stay outside, since they test the checks directly.
    files: ["dispatch/**/*.mjs", "dispatch/**/*.js", "scripts/**/*.mjs", "scripts/**/*.js"],
    ignores: ["scripts/lib/ready-work.mjs"],
    rules: {
      "no-restricted-imports": refuseChecks(),
      "governor/no-dynamic-readiness-checks": refuseDynamicChecks(),
    },
  },
  {
    // The PR review's test 1 asks only whether a ticket is claimed or
    // excluded, which its labels answer.
    files: ["dispatch/checklist.mjs"],
    rules: {
      "no-restricted-imports": refuseChecks("labelRow"),
      "governor/no-dynamic-readiness-checks": refuseDynamicChecks("labelRow"),
    },
  },
  {
    // Wait end asks whether a person moved the line's date later, whatever
    // the labels say, so a claimed ticket's item is rewritten, not dropped.
    files: ["dispatch/waits.mjs"],
    rules: {
      "no-restricted-imports": refuseChecks("isWaiting"),
      "governor/no-dynamic-readiness-checks": refuseDynamicChecks("isWaiting"),
    },
  },
];
