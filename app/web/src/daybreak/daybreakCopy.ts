// Member-facing copy for the Daybreak screen, as pure functions pinned by tests
// (Ruling 7, decisions/2026-09-25-daybreak-member-screen-seven-rulings.md; the
// shape of ../components/certExpiryNotice.ts and ../components/channelStaleness.ts).
// DRAFTED BY THE IMPLEMENTER; ETHAN APPROVES EVERY STRING IN THE PR.
//
// ⚠ ONE GENERIC STATE (Ruling 4). Anything without a recognised code — a
// non-JSON error (whose "code" the client fills with HTTP status text,
// api/client.ts:68), a browser network error, an unknown code — gets
// GENERIC_ERROR. Nothing here ever echoes a code, a status or an error message
// back to the member.
//
// ⚠ COPY CONSTRAINT: nothing here may say "ask your node operator" or "contact
// your operator". On a member node the farmer IS the node operator, so that
// phrasing routes them back to themselves. Same rule as
// ../components/actionConfirm/confirmAction.ts:132-133 and
// ../components/certExpiryNotice.ts:25-32, pinned by ./daybreakCopy.test.ts
// with the same ban list.
//
// ⚠ NO BAND LABEL IS WRITTEN HERE. Band labels are Kevin's, and reach the
// screen only inside the stamped table.

export type Copy = { headline: string; body: string };

export const DAYBREAK_NAV_LABEL = "Daybreak";
export const DAYBREAK_TITLE = "BitCorn Daybreak";
export const LOADING_TEXT = "Loading the latest edition…";

export const GENERIC_ERROR: Copy = {
  headline: "Daybreak couldn't load",
  body: "Something went wrong fetching the latest edition. This page will try again on its own.",
};

const RETRY = "This page will try again on its own.";

const PROXY_COPY: Record<string, Copy> = {
  node_role_required: {
    headline: "Daybreak isn't available yet",
    body: "Your node is still setting up. Daybreak will appear once it finishes.",
  },
  auth_missing: {
    headline: "Daybreak is waiting on your node",
    body: `This node doesn't have its subscription pass yet. If you've just installed or restarted, give it a minute. ${RETRY} You can check your subscription in Settings.`,
  },
  auth_invalid: {
    headline: "Daybreak couldn't confirm your subscription",
    body: `BitCorn didn't accept this node's subscription pass. It renews itself, so this usually clears within a few minutes. ${RETRY} You can check your subscription in Settings.`,
  },
  // scope_insufficient is deliberately ABSENT, so it gets GENERIC_ERROR (ruled
  // 2026-09-25): the Worker gates this route at payment scope, so it cannot
  // occur, and any words naming a tier would be false — every tier includes
  // Daybreak.
  worker_unavailable: {
    headline: "Daybreak is temporarily unavailable",
    body: `BitCorn's Daybreak service couldn't answer just now. ${RETRY}`,
  },
  upstream_error: {
    headline: "Daybreak is temporarily unavailable",
    body: `BitCorn's Daybreak service had a problem. ${RETRY}`,
  },
  invalid_worker_response: {
    headline: "Daybreak is temporarily unavailable",
    body: `BitCorn's Daybreak service sent something this node couldn't read. ${RETRY}`,
  },
  worker_unreachable: {
    headline: "Daybreak couldn't be reached",
    body: `Your node couldn't reach BitCorn's services just now. ${RETRY} If it keeps happening, check that your node is online.`,
  },
  worker_not_configured: {
    headline: "This node isn't set up to reach Daybreak",
    body: "The BitCorn app on this node is missing the address it uses to reach BitCorn's services. This is unusual — updating the BitCorn app from the Umbrel app store is the first thing to try.",
  },
};

// The Worker's own 503 reasons, nested under worker_unavailable.
const WORKER_REASON_COPY: Record<string, Copy> = {
  daybreak_read_failed: {
    headline: "Daybreak is temporarily unavailable",
    body: `BitCorn couldn't read the latest edition just now. ${RETRY}`,
  },
  service_unconfigured: {
    headline: "Daybreak is temporarily unavailable",
    body: `BitCorn's Daybreak service is being set up. ${RETRY}`,
  },
};

const own = (o: Record<string, Copy>, k: unknown): Copy | undefined =>
  typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

/** A failed read → words. Only a recognised code gets its own; everything else is GENERIC_ERROR. */
export function daybreakErrorCopy(err: { code?: unknown; reason?: unknown } | null | undefined): Copy {
  if (!err) return GENERIC_ERROR;
  const base = own(PROXY_COPY, err.code);
  if (!base) return GENERIC_ERROR;
  if (err.code === "worker_unavailable") return own(WORKER_REASON_COPY, err.reason) ?? base;
  return base;
}

export const NO_EDITION: Copy = {
  headline: "No edition yet",
  body: "There's no recent Daybreak edition to show. Check back soon.",
};

export const HELD_OVER_MARK = "Held over";
export const HELD_OVER_NOTE = "Today's edition hasn't been published. This is the most recent one.";

// Shown beside a KEPT read once polls have failed (useDaybreakEdition.ts,
// DAYBREAK_STALE_THRESHOLD). `when` is an instant, already formatted in the
// browser's zone (daybreakView.ts formatInstant).
export function staleCopy(when: string): string {
  return `Daybreak couldn't refresh, so this may not be the latest edition. Last updated ${when}. This page will keep trying on its own.`;
}

export const Z_TITLE = "Corn-Bitcoin Z-Score";
export const Z_UNAVAILABLE_HEADLINE = "The Z-Score isn't available for this edition";

const Z_REASON_COPY: Record<string, string> = {
  params_unavailable: "The model's settings couldn't be loaded when this edition was prepared.",
  fetch_failed: "The latest corn or bitcoin price couldn't be fetched when this edition was prepared.",
  future_dated_close: "A price was dated after this edition, so it wasn't used.",
  stale_close: "The latest corn or bitcoin price was too old to use when this edition was prepared.",
  computation_failed: "The score couldn't be calculated from this edition's prices.",
};
const Z_REASON_FALLBACK = "The score couldn't be read for this edition.";

export function zUnavailableCopy(reason: unknown): string {
  return (typeof reason === "string" && Object.prototype.hasOwnProperty.call(Z_REASON_COPY, reason) ? Z_REASON_COPY[reason] : undefined) ?? Z_REASON_FALLBACK;
}

const BANDS_ABSENT = "The reading scale hasn't been set yet, so no band is shown.";
const BANDS_UNREADABLE = "The reading scale couldn't be read for this edition, so no band is shown.";

export function bandsUnavailableCopy(reason: unknown): string {
  return reason === "absent" ? BANDS_ABSENT : BANDS_UNREADABLE;
}

export function closesCopy(cornDate: string, btcDate: string): string {
  return `From the corn close of ${cornDate} and the bitcoin close of ${btcDate}.`;
}

export function gaugeAriaLabel(z: string, bandLabel?: string): string {
  return bandLabel ? `${Z_TITLE} ${z}, in the band ${bandLabel}` : `${Z_TITLE} ${z}`;
}

export const SECTION_HEADINGS = {
  kevinsRead: "Kevin's Read",
  insideAgriculture: "Inside Agriculture",
  worthReading: "Worth Reading",
} as const;

// Rendered by the screen, never stored per edition (spec §3.4.3).
export const CLOSER_SIGNATURE = "K. KIMLE · BITCORN DAYBREAK";

/** Every string this module can produce, for the ban test (test 45). */
export function allDaybreakCopy(): string[] {
  const copies = [GENERIC_ERROR, NO_EDITION, ...Object.values(PROXY_COPY), ...Object.values(WORKER_REASON_COPY)];
  return [
    DAYBREAK_NAV_LABEL,
    DAYBREAK_TITLE,
    LOADING_TEXT,
    ...copies.flatMap((c) => [c.headline, c.body]),
    HELD_OVER_MARK,
    HELD_OVER_NOTE,
    staleCopy("Sep 29, 5:55 AM CDT"),
    Z_TITLE,
    Z_UNAVAILABLE_HEADLINE,
    ...Object.values(Z_REASON_COPY),
    Z_REASON_FALLBACK,
    BANDS_ABSENT,
    BANDS_UNREADABLE,
    closesCopy("Monday, September 28, 2026", "Monday, September 28, 2026"),
    gaugeAriaLabel("0.12", "a band"),
    gaugeAriaLabel("0.12"),
    ...Object.values(SECTION_HEADINGS),
    CLOSER_SIGNATURE,
  ];
}
