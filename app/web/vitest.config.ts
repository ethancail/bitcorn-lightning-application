import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vitest config for the web container's unit tests.
//
// Tests live alongside source as `*.test.ts` / `*.test.tsx` (mirrors the API
// container's and cloudflare-worker's convention). The jsdom environment
// supplies `localStorage` and `window` — both used by pendingStore's
// cross-component event broadcast, and by the component renders below.
//
// Standalone from vite.config.ts on purpose: it needs the React plugin for JSX
// but none of the dev-server config.
//
// COMPONENT TESTS ARRIVED 2026-09-18 (the Auto-Buy "Missed buys" block). This
// file's previous comment predicted them and named the change: add
// `@vitejs/plugin-react` and broaden `include` to `*.test.tsx`. Both are done.
//
// ⚠ NO React Testing Library, deliberately. It is not a dependency and adding
// one for a handful of renders would be the larger change; the component tests
// here drive `react-dom/client`'s `createRoot` inside `act()` from
// `react-dom/test-utils` and assert against the real DOM the component
// produced. That approach was proven on this repo before it was adopted — the
// R3 fallback probe rendered the unmodified HistoryTable this way.
//
// setupFiles: the test-network guard. Every test file runs it before anything
// else loads, so no test reaches the network — see its header for the rules.
//
// VITEST_MAX_WORKERS (code-audit-2 "web test memory", ruled 2026-11-19):
// a positive integer sets BOTH maxWorkers and minWorkers. Setting only the max
// throws on vitest 2.1.9 (tinypool: "options.minThreads and options.maxThreads
// must not conflict"), as minWorkers defaults to CPUs − 1. Unset means vitest's
// default. Anything else throws here rather than being ignored. CLI flags still
// win over it: with the variable set, pass both --maxWorkers and --minWorkers,
// or neither.

export function workersFromEnv(raw: string | undefined): { maxWorkers?: number; minWorkers?: number } {
  if (raw === undefined) return {};
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`VITEST_MAX_WORKERS must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  const n = Number(raw);
  return { maxWorkers: n, minWorkers: n };
}

export default defineConfig({
  plugins: [react()],
  test: {
    globals: false,
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/testSetup/networkGuard.ts"],
    testTimeout: 20_000,
    ...workersFromEnv(process.env.VITEST_MAX_WORKERS),
  },
});
