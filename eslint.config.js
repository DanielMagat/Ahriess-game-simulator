// @ts-check
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ["./packages/*/tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,

      // The whole engine is built on discriminated unions (Action, TriggerSpec,
      // Keyword, CombatEvent, TurnMachineEvent...) that will keep growing as more
      // card mechanics get added. A switch with a catch-all `default:` — the
      // pattern this codebase deliberately uses for "not implemented yet, but
      // visibly so" — normally hides missing cases from tsc entirely, since a
      // default satisfies the compiler no matter which members are actually
      // handled. This rule (with its default settings — no options object below
      // is intentional; considerDefaultExhaustiveForUnions stays false) keeps
      // that visibility even with a default present: it lists every union member
      // not given its own explicit case, so a case being missing — or a brand
      // new Action kind arriving without one — shows up as a lint error instead
      // of quietly staying unhandled. It would NOT have caught the shield/plating
      // gap from the code review, since `dealDamage` already had an explicit
      // case — that bug was incomplete logic inside a handled case, not a
      // missing one; this rule only guards the latter.
      "@typescript-eslint/switch-exhaustiveness-check": "error",

      // Same spirit, narrower case: a Promise-returning function used somewhere
      // that doesn't await or return it (easy to do once decision-checkpoint
      // async flows exist) fails the build rather than silently racing.
      "@typescript-eslint/no-floating-promises": "off", // enable once any async hooks exist

      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-unused-vars": "off", // superseded by the TS-aware version above
    },
  },
  {
    // Test files get more leeway than src: assertions frequently narrow a union
    // event type ad hoc (`(e as any).foo`) rather than importing every event
    // shape, and hook/mock implementations routinely need to satisfy an
    // interface's full parameter list without using every parameter. Neither
    // of those is a real risk the way an `any` or an ignored param in the
    // engine itself would be.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
    },
  },
  prettierConfig,
];
