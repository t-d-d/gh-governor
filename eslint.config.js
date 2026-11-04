import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";
import requireCliEnv from "./eslint-rules/require-cli-env.mjs";
import noReadinessChecks from "./eslint-rules/no-readiness-checks.mjs";

// Only scripts/lib/ready-work.mjs combines the readiness checks, through
// `ticketStatus` (docs/constraints/dispatcher-repos.md). A caller elsewhere
// asks it, `mayPickUp` or `mayStartSpec`, so no path puts the checks
// together in its own order.
const READINESS_CHECKS = ["isBlocked", "isWaiting", "waitHolds", "heldUnreadied", "labelRow"];
// One rule reads static imports, export-from and `import()` alike, so the
// import forms cannot drift apart.
const refuseChecks = (allowed) => [
  "error",
  { checks: READINESS_CHECKS, ...(allowed === undefined ? {} : { allowed }) },
];

// The kinds that start sessions plan in their own modules and hand `turnFor`
// a plan for `launchPlan`. turn.mjs may not take a planner's own helpers, so
// a new feature that starts sessions goes in its planner, not in `turnFor`.
// `hookFor`, `duePeriodics` and `periodicPrompt` stay allowed: an event fire
// and `run` use them. no-restricted-imports does not see `import()`.
const PLANNER_HELPERS = [
  { module: "dispatch-router", importNames: ["planSchedule"] },
  { module: "waits", importNames: ["endedWaits", "waitSpecPrompt"] },
  { module: "unblocked", importNames: ["ticketRow", "rowOf", "readyPrompt", "specPrompt"] },
  { module: "hooks", importNames: ["hookPrompt"] },
  { module: "ready-work", importNames: ["ticketStatus", "mayPickUp", "mayStartSpec"] },
];
const refusePlannerHelpers = [
  "error",
  {
    patterns: PLANNER_HELPERS.map(({ module, importNames }) => ({
      // A query or fragment on the path still loads the same module.
      regex: `(^|/)${module}\\.mjs([?#].*)?$`,
      importNames,
      message: "turn.mjs hands a plan to launchPlan. Plan in the kind's planner module instead.",
    })),
  },
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
      governor: { rules: { "require-cli-env": requireCliEnv, "no-readiness-checks": noReadinessChecks } },
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
    rules: { "governor/no-readiness-checks": refuseChecks() },
  },
  {
    // The PR review's test 1 asks only whether a ticket is claimed or
    // excluded, which its labels answer.
    files: ["dispatch/checklist.mjs"],
    rules: { "governor/no-readiness-checks": refuseChecks("labelRow") },
  },
  {
    // Wait end asks whether a person moved the line's date later, whatever
    // the labels say, so a claimed ticket's item is rewritten, not dropped.
    files: ["dispatch/waits.mjs"],
    rules: { "governor/no-readiness-checks": refuseChecks("isWaiting") },
  },
  {
    // A separate rule from the readiness refusal above, so neither replaces
    // the other's options.
    files: ["dispatch/turn.mjs"],
    rules: { "no-restricted-imports": refusePlannerHelpers },
  },
];
