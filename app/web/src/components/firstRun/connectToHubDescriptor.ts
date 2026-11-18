// ConnectToHub's descriptor — the words the card shows and the values it checks.
// Moved out of pages/MemberDashboard.tsx in the separation slice (B.1);
// membershipNotPaid came with membership-gating M2, activateMembership,
// renewMembership and RENEW_MEMBERSHIP_TIERS with membership-gating B1 and L1.
//
// Rewritten for member-first-run-ui slice 2, the Connect card (Ethan's
// rulings, relayed 2026-11-16): member text says "connection" and "BitCorn",
// never "channel" or "hub"; the card has one header, two columns ("How big",
// "How fast") and a footer. The two 100k checks stay two constants.
//
// fee-estimates (2026-11-17/18): the fee options are LIVE. Rates, times and
// costs come from GET /api/fee-estimates through components/fees; every
// option, Economy included, sends the integer rate it shows. The fixed
// FEE_SPEED_OPTIONS (Economy sending nothing, "~770 sats") are gone, and with
// them "Fee set by your node" (MFRUI-ASKS (1)).
// The open-channel confirm dialog keeps its own words until slice 5, except
// its live-rate row (CONFIRM-RULING), which ships with fee-estimates.

export const HUB_PUBKEY = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";

/** The "How big" sizes. `key` is the Choice value; `value` is sats. */
export const CAPACITY_PRESETS = [
  { key: "1m", label: "1M", value: 1_000_000 },
  { key: "5m", label: "5M", value: 5_000_000 },
  { key: "10m", label: "10M", value: 10_000_000 },
] as const;

/** The below-minimum warning shows under this capacity. */
export const MIN_CAPACITY_WARNING_SATS = 100_000;
/** The connect button is disabled under this capacity. */
export const MIN_CAPACITY_OPEN_SATS = 100_000;

// The fee options' keys, labels and order are components/fees'
// (FEE_OPTION_ORDER, FEE_OPTION_LABEL); the card's state holds the KEY (F3).
// Each option's figure is its live open cost (rate × 155 vB, P14), shown by
// both the card (FeeCost: "about $0.59" over "~770 sats") and the footer's
// "network fee about …", so the two always say the same amount.

/** The card's own copy. */
export const CONNECT_TO_HUB_COPY = {
  heading: "Connect to BitCorn",
  lead: "One connection to BitCorn carries all your Lightning payments. It's paid for from your node's bitcoin.",

  // The reachability dot, by what the node knows about BitCorn.
  reachable: "BitCorn reachable",
  addressKnown: "BitCorn's address is known — it connects when you do",
  checking: "Checking BitCorn…",
  notReachable: "BitCorn isn't reachable yet — add BitCorn's address under Technical details",

  howBig: "How big",
  sizeAriaLabel: "Connection size in sats",
  satsUnit: "sats",
  capacityHint: "Recommended: 1M–10M sats. Minimum: 100,000 sats.",
  capacityBelowMinimum: "A connection must be at least 100,000 sats.",
  howFast: "How fast",

  /** The footer summary, before the fee: "<sats> · network fee about <fee>". */
  networkFeeAbout: "network fee about",
  /** The footer summary with no estimate: "<sats> · Fee estimate unavailable" (O7). */
  networkFeeUnavailable: "Fee estimate unavailable",
  connecting: "Connecting…",
  connect: "Connect to BitCorn →",
  openFailed: "Couldn't connect to BitCorn",

  submittedTitle: "Connection submitted",
  // F5: the treasury requires 2 confirmations of member channels
  // (bitcoin.defaultchanconfs=2, Q6). The card itself shows the
  // first-confirmation range (P13 (a)).
  submittedMessage:
    "Your connection to BitCorn is being set up. It's usable after 2 " +
    "confirmations. This page updates on its own.",
  fundingTransaction: "Funding Transaction",

  // Technical details.
  nodeId: "BitCorn's node ID",
  feeRates: "Fee rates",
  // P19 (a): the row shows the live integer rates (components/fees ratesDetail).
  addressLabel: "BitCorn's address",
  optional: "(optional)",
  addressPlaceholder: "e.g. 203.0.113.5:9735 — ask your operator",
  addressHint: "Enter BitCorn's address to connect, or leave it blank if you're already connected.",

  // Upgrade mode (no form until Ethan decides who pays). The current size is
  // its own line under the heading, never inside a sentence (ruling "fix the
  // five" item 3, 2026-11-16); this sentence follows it.
  upgradeHeading: "Make your connection bigger",
  upgradeBody: "A bigger connection lets you receive larger or more frequent payments before it fills up.",

  /**
   * The locked line: shown in place of the form when the treasury's verified
   * verdict is false, and as the error when an open is refused for an unpaid
   * membership (membership-gating M2 item 1, ruling R7: the API's
   * `membership_not_paid`, from its app check or the hub's channel acceptor).
   * R7 fixes the meaning; these words are slice 2's (2026-11-16).
   */
  membershipNotPaid:
    "Your membership isn't paid, so BitCorn can't accept your connection. Pay your membership, then connect.",
  /**
   * The button shown when the treasury's verdict is false (membership-gating
   * B1, Ethan's ruling (a), 2026-11-06). It goes to the Settings membership
   * section; it opens no payment modal. This label is for a member who has
   * never paid (tier prepay), and the fallback for a missing or unrecognised
   * tier (Ethan's ruling L1, 2026-11-06).
   */
  activateMembership: "Activate membership",
  /**
   * The same button's label for a member who has paid and lapsed: the three
   * lapsed tiers in RENEW_MEMBERSHIP_TIERS below (Ethan's ruling L1).
   */
  renewMembership: "Renew membership",
};

/** The tiers that take the renew label (L1); every other tier takes the activate one. */
export const RENEW_MEMBERSHIP_TIERS: readonly string[] = ["worker_lapsed", "routing_lapsed", "close_due"];

/** Where the activate button goes: Settings, focused on the membership section. */
export const ACTIVATE_MEMBERSHIP_PATH = "/settings?focus=membership";
