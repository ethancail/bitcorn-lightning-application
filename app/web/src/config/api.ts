// Central API base abstraction
// - Local dev fallback
// - Umbrel app-proxy will inject window.__API_BASE__ later

declare global {
    interface Window {
      __API_BASE__?: string;
    }
  }
  
  export const API_BASE =
    window.__API_BASE__ ||
    import.meta.env.VITE_API_BASE ||
    "http://localhost:3101";
  