// Central API base abstraction
// - Local dev fallback
// - Umbrel app-proxy will inject window.__API_BASE__ later

declare global {
    interface Window {
      __API_BASE__?: string;
    }
  }
  
  // `window` is read at module load — fine in the browser, but it
  // crashes under the vitest node environment (no jsdom configured).
  // Guard the access so pure-logic modules that transitively import
  // this file (via client.ts, e.g. for fmtSats) stay import-safe in
  // tests. The app-proxy still injects window.__API_BASE__ at runtime.
  const hasWindow = typeof window !== "undefined";

  export const API_BASE =
    (hasWindow ? window.__API_BASE__ : undefined) ||
    import.meta.env.VITE_API_BASE ||
    (hasWindow ? `http://${window.location.hostname}:3101` : "http://localhost:3101");
  