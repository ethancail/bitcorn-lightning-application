// A positive whole-number limit from the environment, or the code's default.
//
// Why this exists (code-audit-2 F02): the payment rate limits were parsed with
// parseInt(v || d) and the swap daily caps with Number(v ?? d). A malformed
// value gave NaN, every comparison against NaN is false, and the limit
// switched off; an empty value gave the swap caps 0, which refused every swap.
// The limits this guards must neither switch off nor brick a member node whose
// operator cannot edit the env, so anything that is not a positive whole number
// falls back to the default, with a warning. Never 0, NaN or Infinity.
//
//   unset, or empty after trimming  → the default, silently (compose's
//                                      ${VAR:-} interpolation yields "")
//   decimal digits, a safe integer > 0 → that number
//   anything else ("abc", "50k", "1e6", "5_000", "10.5", "0", "-5",
//   "0x10", "Infinity", past 2^53)  → the default, with a console.warn
//
// Parsing lives in its own module so it is testable apart from ENV;
// config/env.limits.test.ts proves each limit's value actually reaches ENV.

export function positiveIntEnv(
  name: string,
  defaultValue: number,
  raw: string | undefined = process.env[name],
): number {
  const text = raw?.trim() ?? "";
  if (text === "") return defaultValue;
  const n = /^[0-9]+$/.test(text) ? Number(text) : NaN;
  if (Number.isSafeInteger(n) && n > 0) return n;
  console.warn(
    `[env] ${name}=${JSON.stringify(raw)} is not a positive whole number; using the default ${defaultValue}`,
  );
  return defaultValue;
}
