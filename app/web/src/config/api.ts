// Central API base abstraction
// - Local dev fallback
// - Umbrel app-proxy will inject window.__API_BASE__ later

declare global {
    interface Window {
      __API_BASE__?: string;
    }
  }
  
  const hasWindow = typeof window !== "undefined";

  export const API_BASE =
    (hasWindow ? window.__API_BASE__ : undefined) ||
    import.meta.env.VITE_API_BASE ||
    (hasWindow ? `http://${window.location.hostname}:3101` : "http://localhost:3101");
  