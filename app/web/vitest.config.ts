import { defineConfig } from "vitest/config";

// Vitest config for the web container's unit tests.
//
// Tests live alongside source as `*.test.ts` (mirrors the API container's
// and cloudflare-worker's convention). The jsdom environment supplies
// `localStorage` and `window` — both used by pendingStore's cross-component
// event broadcast.
//
// Standalone from vite.config.ts on purpose: this first test target
// (pendingStore) is pure TS with no JSX, so it doesn't need the React
// plugin or the dev-server config. When component tests arrive (React
// Testing Library), add `@vitejs/plugin-react` to a `plugins: [react()]`
// here and broaden `include` to `*.test.tsx`.
export default defineConfig({
  test: {
    globals: false,
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
