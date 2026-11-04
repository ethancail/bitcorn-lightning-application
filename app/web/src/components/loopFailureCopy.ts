// The member-facing sentence for a swap's failure_reason (drive-mode P2 item
// 7; R18(12)). P1 stores loopd's raw code (swapPoller.ts); this is what a
// member reads instead. Each sentence says what happened, where the money is,
// and what to do (C6). The raw value stays in Technical details. Pure data,
// the autoPayAlertContent pattern (subscriptionBanner.ts).
//
// ─── WHERE THE MONEY IS: CHECKED AGAINST LOOPD'S SOURCE ─────────────────────
//
// Every money claim below was checked against loopd v0.33.0-beta (the version
// Bitcorn ships), at ~/.bitcorn-dev/loop-src; failure reasons are mapped from
// swap states at loopd/swapclient_server.go:350-375.
//
// Withdraw (Loop Out):
//   OFFCHAIN — loopout.go:1059-1078: the swap payment failed; loopd's own
//     comment, "We may have lost the prepayment". :1080-1099: the prepay
//     failed; "the swap payment will be canceled or time out". So the amount
//     stays in the connection and the prepay may not come back.
//   TIMEOUT — loopout.go:1031-1043, :1268-1275, :1479-1489: the preimage is
//     never revealed, "we have not had any coins pulled off-chain"; the server
//     cannot settle the swap payment. The prepay may not come back.
//   SWEEP_TIMEOUT — loopout.go:623-629: the HTLC was spent by the server's
//     timeout path, not our sweep; looprpc/client.proto:677-681. A sweep attempt
//     reveals the preimage, so the off-chain payment may have settled: the
//     only case where the amount may have left without arriving.
//   INSUFFICIENT_VALUE — loopout.go:590-597: the HTLC held less than asked,
//     so the preimage is not revealed and the swap payment cannot settle.
//   TEMPORARY — loopout.go:398-405 (loopin.go:566-571 for Top Up): an
//     unexpected error, NOT a final state, set so that the swap is not
//     abandoned; looprpc/client.proto:690-693, "Manual intervention such as a restart
//     is required". loopd is a service in Bitcorn's own compose, so the
//     restart that reaches it is Bitcorn's (CLAUDE.md, restart cascade).
// Top Up (Loop In):
//   TIMEOUT — loopin.go:776-779: too late to publish, nothing sent; or
//     loopin.go:1074-1081: our timeout transaction confirmed, the bitcoin is
//     back on-chain less its fee. Both: in the Bitcoin balance.
//   INCORRECT_AMOUNT — loopin.go:640-647: loopd waits for the HTLC to expire,
//     then reclaims it with a timeout transaction.
//   INCORRECT_HTLC_AMT_SWEPT — loopin.go:1074-1079: that reclaim confirmed.
//   INSUFFICIENT_CONFIRMED_BALANCE — loopin.go:801-815: SendOutputs failed,
//     so no HTLC was published.
//   ABANDONED — loopin.go:1158-1170, Loop In only; only `loop abandonswap`
//     sets it (Bitcorn never calls AbandonSwap). looprpc/client.proto:1573-1577:
//     abandoning risks funds "if an abandoned swap would wait on a timeout
//     sweep by the client".
// Bitcorn's own values:
//   "Quote expired" — swapPoller.ts:13-20, only rows never executed.
//   "interrupted" — swapPoller.ts:118-130: Bitcorn cannot tell whether loopd
//     started the swap; one it started "still runs in loopd".
//   requote_required, fee_rate_over_quote, miner_fee_unknown —
//     swapService.ts:200-252, refused before any money-moving loopd call.
//   "Loop state: <STATE>" (swapPoller.ts:96) and any other error text
//     (swapService.ts:323-326, around the loopd call itself): no money claim.

export type SwapDirection = "loop_out" | "loop_in";

const NOUN: Record<SwapDirection, string> = { loop_out: "withdrawal", loop_in: "top-up" };

/** The sentences only one direction's loopd can produce. */
const LOOPD: Record<SwapDirection, Record<string, string>> = {
  loop_out: {
    FAILURE_REASON_OFFCHAIN:
      "Loop couldn't route the withdrawal's Lightning payment within its fee limit, so it stopped. " +
      "The amount stayed in your connection, but the prepay may not come back. Try again later or with a smaller amount.",
    FAILURE_REASON_TIMEOUT:
      "The withdrawal ran out of time before your node could claim the bitcoin, so it stopped. " +
      "The amount stayed in your connection, but the prepay may not come back. Try again.",
    FAILURE_REASON_SWEEP_TIMEOUT:
      "Your node didn't claim the bitcoin in time, and the swap service took it back. " +
      "The amount may have left your connection without reaching your wallet; check your Bitcoin balance.",
    FAILURE_REASON_INSUFFICIENT_VALUE:
      "The swap service sent less bitcoin than agreed, so your node refused it. " +
      "The amount stayed in your connection, but the prepay may not come back. Try again.",
    FAILURE_REASON_TEMPORARY:
      "The withdrawal stopped partway because of an error on this node and isn't finished. " +
      "Restart Bitcorn so Loop can pick it up, and don't start another until this one completes or fails.",
  },
  loop_in: {
    FAILURE_REASON_TIMEOUT:
      "The top-up ran out of time before it finished, so it stopped. " +
      "Your bitcoin is in your Bitcoin balance, less any network fees already paid. Try again.",
    FAILURE_REASON_TEMPORARY:
      "The top-up stopped partway because of an error on this node and isn't finished. " +
      "Restart Bitcorn so Loop can pick it up, and don't start another until this one completes or fails.",
    FAILURE_REASON_INCORRECT_AMOUNT:
      "The bitcoin sent for the top-up didn't match the agreed amount, so the swap stopped. " +
      "Your node takes it back to your Bitcoin balance once the swap's time limit passes; nothing else is needed.",
    FAILURE_REASON_ABANDONED:
      "This top-up was cancelled by hand on this node, so Loop stopped following it. " +
      "If bitcoin had already been sent for it, it may need to be recovered by hand.",
    FAILURE_REASON_INSUFFICIENT_CONFIRMED_BALANCE:
      "Your Bitcoin balance didn't have enough confirmed bitcoin to start the top-up, so nothing was sent. " +
      "Wait for incoming bitcoin to confirm, or top up a smaller amount.",
    FAILURE_REASON_INCORRECT_HTLC_AMT_SWEPT:
      "The bitcoin sent for the top-up didn't match the agreed amount, so your node took it back. " +
      "It's in your Bitcoin balance, less the network fee for taking it back.",
  },
};

/** Bitcorn's own values, the same in both directions. */
function bitcorn(reason: string, noun: string): string | null {
  switch (reason) {
    case "Quote expired":
      return "The quote expired before it was used, so nothing was sent. Get a new quote.";
    case "interrupted":
      return (
        `Bitcorn restarted while the ${noun} was starting, so it can't tell whether the swap began. ` +
        "If it did, Loop finishes it on its own; check your balances before trying again."
      );
    case "requote_required":
      return "This quote was made before an update and can't be used, so nothing was sent. Get a new quote.";
    case "fee_rate_over_quote":
      return "Bitcoin network fees went up after this quote, so nothing was sent. Get a new quote.";
    case "miner_fee_unknown":
      return "Your node couldn't estimate the Bitcoin network fee, so nothing was sent. Try again in a few minutes.";
  }
  if (reason.startsWith("Loop state: ")) {
    return `Loop ended the ${noun} without giving a reason. Check your balances before trying again.`;
  }
  return null;
}

/** The sentence for a failure_reason. An unknown or missing value gets a
 *  generic sentence that makes no claim about where the money is. */
export function loopFailureSentence(reason: string | null, direction: SwapDirection): string {
  const noun = NOUN[direction];
  if (reason) {
    const fromLoopd = LOOPD[direction][reason];
    if (fromLoopd) return fromLoopd;
    const own = bitcorn(reason, noun);
    if (own) return own;
  }
  return `The ${noun} didn't go through. Check your balances before trying again.`;
}
