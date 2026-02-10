// API client for web frontend
// TODO: Configure HTTP client (axios/fetch) with base URL and auth
import { API_BASE } from "../config/api";

export async function checkHealth(): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/health`);

  if (!res.ok) {
    throw new Error(`Health check failed: ${res.status}`);
  }

  return res.json();
}
