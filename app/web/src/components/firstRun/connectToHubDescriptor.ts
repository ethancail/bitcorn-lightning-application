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
// Carried as they are, NOT fixed: the Economy option sends no fee rate (its
// rate is left unset), and Normal's and Priority's fees are fixed estimates,
// not quotes. Economy shows no figure and no rate (rulings "a" and "fix the
// five", 2026-11-16).
// The open-channel confirm dialog keeps its own words until slice 5.

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

// `key` is the Choice value (lowercase, ruled 2026-11-13); it maps back to the
// option's rate. `feeSats` is the estimate both the card (FeeCost: "about
// $0.59" over "~770 sats", ruling "fix the five" item 5) and the footer's
// "network fee about …" show, so the two always say the same amount.
// Economy sends no fee rate, so the node picks it and nothing computes a figure:
// its card and the footer say the node sets the fee, with no number (Ethan's
// ruling "a", 2026-11-16). What it sends is unchanged.
export const FEE_SPEED_OPTIONS = ([
  { key: "economy", label: "Economy", rate: undefined, desc: "cheapest", time: "1–3 hours", feeSats: null },
  { key: "normal", label: "Normal", rate: 5, desc: "balanced", time: "~30 min", feeSats: 770 },
  { key: "priority", label: "Priority", rate: 15, desc: "fastest", time: "~10 min", feeSats: 2_300 },
] as const);

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
  /** The footer summary with Economy: "<sats> · network fee set by your node". */
  networkFeeSetByNode: "network fee set by your node",
  connecting: "Connecting…",
  connect: "Connect to BitCorn →",
  openFailed: "Couldn't connect to BitCorn",

  submittedTitle: "Connection submitted",
  submittedMessage:
    "Your connection to BitCorn is being set up. It's ready after 1–3 on-chain " +
    "confirmations. This page updates on its own.",
  fundingTransaction: "Funding Transaction",

  // Technical details.
  nodeId: "BitCorn's node ID",
  feeRates: "Fee rates",
  // Economy shows no rate: it sends none (ruling "fix the five" item 4).
  feeRatesDetail: "Normal ~5 sat/vB · Priority ~15 sat/vB",
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
