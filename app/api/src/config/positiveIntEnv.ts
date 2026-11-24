// A positive whole-number limit from the environment, or the code's default
// (code-audit-2 F02). Since the F02 follow-up it is one wrapper over the
// numberEnv core, which holds the semantics and the reasons for them; this
// module keeps F02's import path and its tests (positiveIntEnv.test.ts).
//
//   unset, or empty after trimming     → the default, silently
//   decimal digits, a safe integer > 0 → that number
//   anything else ("abc", "50k", "1e6", "5_000", "10.5", "0", "-5",
//   "0x10", "Infinity", past 2^53)    → the default, with a console.warn

export { positiveIntEnv } from "./numberEnv";
