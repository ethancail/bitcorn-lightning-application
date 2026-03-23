/**
 * Loop availability detector — checks whether loopd is reachable
 * on the member node and fetches Loop Out/In terms if available.
 *
 * Never throws — always returns a result object.
 */

import { isLoopAvailable as checkLoopDaemon, getLoopOutTerms } from "../lightning/loop";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LoopTerms {
  minSats: number;
  maxSats: number;
}

export interface LoopAvailability {
  loopDaemonRunning: boolean;
  loopOutAvailable: boolean;
  loopInAvailable: boolean;
  loopOutTerms: LoopTerms | null;
  loopInTerms: LoopTerms | null;
}

// ─── Detection ───────────────────────────────────────────────────────────────

export async function checkLoopAvailability(): Promise<LoopAvailability> {
  const result: LoopAvailability = {
    loopDaemonRunning: false,
    loopOutAvailable: false,
    loopInAvailable: false,
    loopOutTerms: null,
    loopInTerms: null,
  };

  // Step 1: Check if loopd is reachable
  const daemon = await checkLoopDaemon();
  if (!daemon.available) return result;

  result.loopDaemonRunning = true;

  // Step 2: Try to fetch Loop Out terms
  try {
    const terms = await getLoopOutTerms();
    if (terms.min_swap_amount > 0 && terms.max_swap_amount > 0) {
      result.loopOutAvailable = true;
      result.loopOutTerms = {
        minSats: terms.min_swap_amount,
        maxSats: terms.max_swap_amount,
      };
    }
  } catch {
    // Loop Out not available — leave as false
  }

  // Loop In availability — real gRPC check
  let loopInAvailable = false;
  let loopInTerms: { minSats: number; maxSats: number } | null = null;
  try {
    const { getLoopInTerms } = await import("../lightning/loop");
    const terms = await getLoopInTerms();
    loopInAvailable = true;
    loopInTerms = { minSats: terms.min_swap_amount, maxSats: terms.max_swap_amount };
  } catch {
    // Loop In not available
  }

  result.loopInAvailable = loopInAvailable;
  result.loopInTerms = loopInTerms;

  return result;
}
