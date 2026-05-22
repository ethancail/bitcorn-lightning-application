import { defineConfig } from "vitest/config";

// Minimal vitest config for the API container.
// Tests live alongside source as `*.test.ts` (per the cloudflare-worker
// convention; the API container had no test infrastructure before).
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
