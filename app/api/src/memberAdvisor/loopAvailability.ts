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

  // Step 3: Loop In — not yet implemented in our loop.ts client.
  // loopd supports LoopInTerms RPC but we haven't wrapped it.
  // Leave loopInAvailable = false for v1.
  // When Loop In is added to loop.ts, uncomment:
  // try {
  //   const terms = await getLoopInTerms();
  //   result.loopInAvailable = true;
  //   result.loopInTerms = { minSats: terms.min_swap_amount, maxSats: terms.max_swap_amount };
  // } catch {}

  return result;
}
