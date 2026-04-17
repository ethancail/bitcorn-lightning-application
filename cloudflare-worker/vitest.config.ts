import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

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
