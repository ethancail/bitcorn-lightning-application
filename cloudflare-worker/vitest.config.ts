import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Pin the test pool to UTC, which is what deployed Workers run in. Without this
// the local workerd inherits the HOST's zone: on a Chicago machine a date bug
// built on Date's local getters (getDate, getHours, …) passes here and is wrong
// in production. Set here, not in a package.json script, because runs in this
// repo invoke vitest.mjs directly and bypass npm scripts; this file is loaded
// by vitest's main process before the pool spawns workerd, which inherits it.
// Proven by negative control: a local-getters "Central date" mutant in
// src/daybreak/dates.ts goes red with this line and green without it.
process.env.TZ = "UTC";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // pool-workers 0.5.x hard-asserts one of nodejs_compat / nodejs_compat_v2
          // is present at startup. Setting it here keeps production wrangler.toml
          // untouched until Task 25, which adds the same flag to wrangler.toml
          // proper (this override becomes redundant at that point but harmless).
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
  },
});
