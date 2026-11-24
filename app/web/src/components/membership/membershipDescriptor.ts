// The Membership panel's words (member-first-run-ui slice 4, the simplified
// Membership panel; the ruled design, 2026-11-13 §2–§4, and Ethan's "recs",
// relayed 2026-11-18, R1–R9). Member text says "connection" and "BitCorn",
// never "channel", "hub" or "operator".
//
// Three tiers (the ruled design, drawn for the overdue state; R6 places the
// rest):
//   always visible — the heading and its mark, the plain sentences, the big
//     amount ("Renew for" / "Renews for" / "Activate for"), the cadence line,
//     the one button with its line (R3), and the "Renew automatically" switch
//     with its one line (R2);
//   one tap away, as closed rows — "Other ways to pay", "What's paused?" (or
//     "What's included" before the first payment), "What happens next",
//     "About automatic renewal", "Payment history" (R4, R5), and "Details" on
//     the error states;
//   only when it applies — the trust notice, the waiting notice, the errors.
//
// Every fact on the panel before this slice stays reachable. Its sentences are
// carried as they were, but for "BitCorn" (R8) and the fixes R8 names; the
// always-visible lines are the ruled design's.

import { formatSats } from "../amount/amountDescriptor";

export const MEMBERSHIP_COPY = {
  heading: "Membership",

  // ── The marks ──────────────────────────────────────────────────────────
  mark: {
    overdue: "Overdue",
    servicesPaused: "Services paused",
    paidUp: "Paid up",
    due: "Due",
    notActive: "Not active yet",
    /** NOT RULED: today's pills, capitalized like the ruled marks. */
    unclassified: "Unclassified",
    settingUp: "Setting up",
    unavailable: "State unavailable",
    couldntLoad: "Couldn't load",
    unreachable: "Treasury unreachable",
  },

  // ── Always visible ─────────────────────────────────────────────────────
  overdueLead: "Your membership is overdue, so some services are paused.",
  /** Only while the treasury's Tier 3 can't close (connectionStaysOpen). */
  stillOpen: "Your connection to BitCorn is still open and its balance is unchanged.",
  paidUpLead: "Your connection to BitCorn and your hosted services are paid up.",
  /** The pre-pause sentence, and its ask (hidden while payments are blocked). */
  dueLead: (date: string) => `Hosted services pause on ${date}.`,
  dueAsk: "Renew before then to keep them running.",
  /** Ruled 2026-11-20 ("recs", 2): the never-paid lead, and its ask (hidden
   *  while payments are blocked, G3). */
  prepayLead: "Your membership isn't active yet.",
  prepayAsk: (amount: string) => `Pay ${amount} to start it.`,

  renewFor: "Renew for",
  renewsFor: "Renews for",
  activateFor: "Activate for",

  /** "Every 30 days · was paid through Oct 14, 2026 (35 days ago)". */
  cadencePast: (period: number, date: string, daysAgo: number) =>
    `Every ${period} days · was paid through ${date} (${daysAgo === 0 ? "today" : `${daysAgo} ${daysAgo === 1 ? "day" : "days"} ago`})`,
  /** "Every 30 days · paid through Dec 1, 2026 (in 10 days)". */
  cadenceAhead: (period: number, date: string, daysUntil: number) =>
    `Every ${period} days · paid through ${date} (${daysUntil === 0 ? "today" : daysUntil === 1 ? "tomorrow" : `in ${daysUntil} days`})`,
  cadencePrepay: (period: number) => `Every ${period} days · starts on your first payment`,

  renewButton: "Renew from your node",
  payButton: "Pay from your node",
  /** R3, under the button. Hidden while payments are blocked: it describes a
   *  payment the node won't make (NOT RULED: the G3 rule, applied here). */
  uses: (amount: string) => `Uses ${amount} of your node's bitcoin, plus a small network fee.`,

  // ── The switch (R2) ────────────────────────────────────────────────────
  switchLabel: "Renew automatically",
  switchOn: "Pays from your node's bitcoin when your membership lapses.",
  switchOff: "Turn on to renew from your node's bitcoin automatically.",
  on: "On",
  off: "Off",
  /** The G3 pointer, verbatim (one S-state per panel screen, 2026-11-11). */
  autoPayPaused: "Auto-pay is paused (see above).",
  autoPayLoadFailed: "Couldn't load auto-pay settings. It will retry when you reload.",
  autoPaySaveFailed: "Could not update auto-pay.",

  // ── The rows ───────────────────────────────────────────────────────────
  row: {
    otherWays: "Other ways to pay",
    paused: "What's paused?",
    included: "What's included",
    next: "What happens next",
    about: "About automatic renewal",
    history: "Payment history",
    details: "Details",
    /** NOT RULED: the not-applicable states' price row. */
    price: "Price",
  },

  // "Other ways to pay".
  /** The ruled design's "send exactly N sats": the QR's amount, in sats. */
  sendExactly: (sats: number, period: number) => `Send exactly ${formatSats(sats)} to renew for ${period} days.`,
  sendExactlyActivate: (sats: number) => `Send exactly ${formatSats(sats)} to activate.`,
  addressLabel: "ADDRESS",
  copyAddress: "Copy address",
  copied: "✓ Copied",
  fineprintCurrent: "This address is yours for the lifetime of your membership. Payments are detected automatically on first confirmation.",
  fineprintPrepay:
    "This address is yours for the lifetime of your membership. Don't have BTC on hand? Use Coinbase Onramp from the Buy Bitcoin tab — funds land in this wallet.",
  fineprintLapsed:
    "Don't have BTC on hand? Use Coinbase Onramp from the Buy Bitcoin tab — it's still available in this state. Funds you buy land in this same wallet.",
  /** The C15 pointer, verbatim. */
  addressHidden: "Payment address hidden while payments are paused (see above).",
  onramp: "Open Coinbase Onramp",
  onrampOpening: "Opening…",
  /** R4: "Refresh token" renamed; it reads the status again. */
  checkAgain: "Check again",

  // "What's paused?" (the overdue family). The services by their names on a
  // member's screens (R45 Q5), the banner's sentence; the ask, hidden while
  // payments are blocked.
  services: "Hosted services are paused: Auto‑Buy, with its Valuation Chart, and Stablecoin settlements.",
  restoreAsk: (amount: string) => `Pay ${amount} to restore them.`,
  stillUse: "You can still use Coinbase Onramp to buy BTC and renew, and check your connection from this dashboard.",

  // "What's included" (before the first payment).
  availableNow:
    "Available now — Coinbase Onramp for buying BTC, BTC/USD price reads, and the address below for receiving your first payment.",
  activatesOnFirst:
    "Activates on first payment — Lightning routing through the treasury, full hosted services, valuation engine, and complete dashboard.",

  // "What happens next".
  ifRenew: (period: number) =>
    `If you renew — recovery is fully in-app. Your payment counts after its first confirmation on the Bitcoin network, usually within an hour. Then all paused services come back online, and your paid-through date advances by ${period} days.`,
  ifNotRenew: "If you don't renew — hosted services stay paused and your connection to BitCorn stays open.",
  rightNow: "Right now — your connection to BitCorn remains open and its balance is unchanged.",
  /** NOT RULED: paid up and due soon have no timeline today; these say what
   *  the status's own dates say. */
  renewCounts: (period: number) =>
    `If you renew — your payment counts after its first confirmation on the Bitcoin network, usually within an hour, and your paid-through date advances by ${period} days.`,
  pausesOn: (date: string) => `If you don't renew — hosted services pause on ${date}.`,

  // "Payment history" (R4, R5).
  lastPayment: (date: string) => `Last payment: ${date}, confirmed.`,
  noPayment: "Last payment: none yet.",
  seeAll: "See all payments",

  // "About automatic renewal": the auto-pay card's sentences, as they were.
  aboutLapsedNow: (amount: string) =>
    `Your subscription has lapsed and hosted services are paused, so your node will pay ${amount} from its Bitcoin balance to renew it.`,
  aboutIfLapses: (amount: string, pauseDate: string | null) =>
    `If your subscription lapses, your node pays ${amount} from its Bitcoin balance to renew it. That happens after hosted services pause${pauseDate ? ` on ${pauseDate}` : ""}, so turning this on doesn't prevent the pause.`,
  aboutRequires: "Requires sufficient on-chain BTC and your node to be online.",
  aboutNeverMore:
    "It never pays more than the price you last accepted, and it won't pay again while an earlier payment hasn't been credited.",
  aboutOptOut: "You can opt out at any time.",
  aboutOffLine: "When on, your node renews from its Bitcoin balance once your subscription has lapsed.",
  enabledAgo: (ago: string) => `Enabled ${ago}`,
  historyShow: "View auto-pay history →",
  historyHide: "Hide auto-pay history",
  historyEmpty: "No auto-pay events yet.",
  /** R8: a failed read says so, not "no events". NOT RULED: the words. */
  historyFailed: "Couldn't load the auto-pay history.",

  // ── Not applicable ─────────────────────────────────────────────────────
  externalPeer:
    "This node is configured as a routing peer. Subscription doesn't apply to this node. If you believe this is incorrect, contact BitCorn.",
  unclassified:
    "Your node's role is pending classification. Subscription doesn't activate until your connection is classified as farmer or merchant. Contact BitCorn if this lasts more than a few minutes.",
  /** NOT RULED: the price row's sentence. */
  priceIs: (amount: string) => `Membership costs ${amount} a month.`,
  priceUnknown: "The membership price isn't available yet.",
  settingUpHeadline: "Setting up your subscription",
  settingUpBody:
    "The sync loop is allocating your deposit address. This usually takes ~15 seconds. Your address, QR code, and renewal options will appear here automatically when setup completes.",
  stuck: "Taking longer than expected.",
  refreshNow: "Refresh now",
  connectionAge: (sec: number) => `connection detected ${sec}s ago`,
  missing:
    "Your subscription state couldn't be loaded — this is unexpected. The subscription row should exist but isn't responding. This is usually a temporary sync issue that resolves within a minute, but may indicate something the system needs help with.",
  checkingEvery: (duration: string) => `Checking again automatically every 15 seconds — in this state for ${duration}.`,
  inStateFor: (duration: string) => `In this state for ${duration}.`,
  memberIdLabel: "YOUR MEMBER PUBKEY",
  copyPubkey: "Copy pubkey",
  shareWithSupport: "Share this with BitCorn if you contact support.",
  tryNow: "Try now",
  trying: "Trying…",
  missingFooter:
    "If this persists for more than a few minutes, contact BitCorn with the pubkey above. The auto-retry will keep running in the background until the state loads.",
  noChannel:
    "You don't have a connection to BitCorn yet. Connect from your dashboard to enroll in the subscription system. If you believe you should have a connection, contact BitCorn.",
  connect: "Connect to BitCorn",

  // ── Errors ─────────────────────────────────────────────────────────────
  infraError: "Couldn't load subscription state — infrastructure not ready.",
  networkError: "Couldn't load subscription state.",
  unreachable: "Couldn't reach the treasury. Retrying automatically — service should recover when the connection is restored.",
} as const;
