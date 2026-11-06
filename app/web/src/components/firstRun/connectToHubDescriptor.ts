// ConnectToHub's descriptor — the literals the form shows and checks, moved
// unchanged out of pages/MemberDashboard.tsx (member-first-run-ui separation
// slice, B.1). Nothing here was new at the move: each value was the old code's,
// and each literal occurred exactly as many times as it did there (D1). One
// entry has been added since — membershipNotPaid (membership-gating M2). The two
// 100k checks stay two constants; merging them is out of the slice (D1).
//
// Carried as they are, NOT fixed (B): the Economy option sends no fee rate
// (its rate is left unset); the submitting label on an on-chain open; the
// operator copy. Comments here never repeat a literal, so D1's counts hold.

export const HUB_PUBKEY = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";

export const CAPACITY_PRESETS = [
  { label: "1M", value: 1_000_000 },
  { label: "5M", value: 5_000_000 },
  { label: "10M", value: 10_000_000 },
];

/** The below-minimum warning shows under this capacity. */
export const MIN_CAPACITY_WARNING_SATS = 100_000;
/** The open button is disabled under this capacity. */
export const MIN_CAPACITY_OPEN_SATS = 100_000;

export const FEE_SPEED_OPTIONS = ([
  { label: "Economy", rate: undefined, desc: "cheapest", time: "1–3 hours", cost: "~155 sats" },
  { label: "Normal", rate: 5, desc: "balanced", time: "~30 min", cost: "~770 sats" },
  { label: "Priority", rate: 15, desc: "fastest", time: "~10 min", cost: "~2,300 sats" },
] as const);

/** The form's own copy, one entry per occurrence in the old code. */
export const CONNECT_TO_HUB_COPY = {
  submittedTitle: "Channel opening submitted",
  submittedMessage:
    "Your channel to the hub is being broadcast. It will become active after " +
    "1–3 on-chain confirmations. This page will update automatically.",
  fundingTransaction: "Funding Transaction",
  noHubTitle: "No hub channel",
  noHubMessage: "Open a channel to the hub to start sending and receiving Lightning payments.",
  capacityLabel: "Channel Capacity",
  capacityAriaLabel: "Channel Capacity",
  satsUnit: "sats",
  capacityHint: "Recommended: 1M–10M sats. Minimum: 100,000 sats.",
  capacityBelowMinimum: "Channel capacity must be at least 100,000 sats.",
  peered: "Connected to hub — ready to open a channel",
  autoSocket: "Hub address available — will connect automatically when you open a channel",
  hubAddressLabel: "Hub Address",
  optional: "(optional)",
  hubAddressAriaLabel: "Hub Address",
  hubAddressPlaceholder: "e.g. 203.0.113.5:9735 — ask your operator",
  hubAddressHint: "Enter the hub's address to connect, or leave blank if already connected.",
  confirmationSpeed: "Confirmation Speed",
  connecting: "Connecting…",
  openChannel: "Open Channel →",
  hubNodeId: "Hub node ID",
  feeRates: "Fee rates",
  feeRatesDetail: "Economy ~1 sat/vB · Normal ~5 sat/vB · Priority ~15 sat/vB",
  openFailed: "Failed to open channel",
  /**
   * The hub refused because this node's membership isn't paid (membership-
   * gating M2 item 1, ruling R7): the API's `membership_not_paid`, from its
   * app check or from the hub's channel acceptor. Not from the old code — a
   * new literal. member-first-run-ui owns this surface and may restyle the
   * words; their meaning is fixed by R7. Reworded by Ethan's ruling S2
   * (2026-11-05); the acceptor's own refusal text is unchanged.
   */
  membershipNotPaid:
    "Your membership isn't paid, so the hub can't accept your channel. Pay your membership, then connect.",
  /**
   * The button shown when the treasury's verdict is false (membership-gating
   * B1, Ethan's ruling (a), 2026-11-06). It goes to the Settings membership
   * section; it opens no payment modal.
   */
  activateMembership: "Activate membership",
};

/** Where the activate button goes: Settings, focused on the membership section. */
export const ACTIVATE_MEMBERSHIP_PATH = "/settings?focus=membership";
