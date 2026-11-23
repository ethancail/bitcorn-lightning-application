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
// ENVIRONMENTS (code-audit-2 "web test memory", ruled 2026-11-19): a jsdom
// worker costs ~80 MB more than a node one (measured 2026-11-20, VmHWM per
// worker: 165 → 86 MB, 170 → 96 MB). The rule, by file name:
//   - `*.test.tsx` → jsdom (the `environment` default; every one renders)
//   - `*.test.ts`  → node, EXCEPT the files in DOM_TS_TESTS, which use the DOM
// A new `.test.ts` that touches `document`/`window` fails under node with
// "ReferenceError: document is not defined" — add it to DOM_TS_TESTS. Beware
// code that branches on `typeof window`: under node it takes the no-window
// branch silently. environmentMatchGlobs is first-match-wins, so the exceptions
// come before the node glob. A file's own environment docblock outranks every
// glob (vitest reads it from the whole file text); none is used here, and
// src/testSetup/environmentMatch.test.ts (the control) fails if one appears.
//
// VITEST_MAX_WORKERS (code-audit-2 "web test memory", ruled 2026-11-19):
// a positive integer sets BOTH maxWorkers and minWorkers. Setting only the max
// throws on vitest 2.1.9 (tinypool: "options.minThreads and options.maxThreads
// must not conflict"), as minWorkers defaults to CPUs − 1. Unset means vitest's
// default. Anything else throws here rather than being ignored. CLI flags still
// win over it: with the variable set, pass both --maxWorkers and --minWorkers,
// or neither.

/** `.test.ts` files that need the DOM, so stay on jsdom. Paths relative to app/web. */
export const DOM_TS_TESTS: readonly string[] = [
  "src/components/copyText.test.ts", // navigator.clipboard, document.execCommand
  "src/confirmInput.test.ts", // createRoot render
  "src/inputZoom.test.ts", // document.createElement + Element.matches
  "src/logoTheme.test.ts", // <style> injection + getComputedStyle
  "src/stablecoin/pendingStore.test.ts", // localStorage + window events
  "src/stablecoin/secureContext.test.ts", // window.isSecureContext
  "src/stablecoin/wagmi.analytics.test.ts", // the MetaMask SDK inits as a browser only with window
  "src/testSetup/networkGuard.test.ts", // jsdom's XMLHttpRequest, WebSocket, navigator
];

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
    environmentMatchGlobs: [
      ...DOM_TS_TESTS.map((f): [string, "jsdom"] => [f, "jsdom"]),
      ["src/**/*.test.ts", "node"],
    ],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/testSetup/networkGuard.ts"],
    testTimeout: 20_000,
    ...workersFromEnv(process.env.VITEST_MAX_WORKERS),
  },
});
