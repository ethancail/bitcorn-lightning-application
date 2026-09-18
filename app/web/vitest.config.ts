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
export default defineConfig({
  plugins: [react()],
  test: {
    globals: false,
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    testTimeout: 10_000,
  },
});
