// Editor-facing copy for the Daybreak Editor (the CMS, spec §3.4.5), as pure
// functions pinned by tests — the shape of ../daybreak/daybreakCopy.ts.
// DRAFTED BY THE IMPLEMENTER; ETHAN APPROVES EVERY STRING IN THE PR (ruling (C),
// decisions/2026-10-07-daybreak-cms-open-items-two-edition-dates-publish-saves-first.md).
//
// ⚠ ONE GENERIC STATE per failure kind. Anything without a recognised code — a
// non-JSON error (whose "code" the client fills with HTTP status text), a
// browser network error, an unknown code — gets the generic words. Nothing
// here echoes a code, a status or an error message back to the reader.
//
// ⚠ COPY CONSTRAINT, reused from the member screen: nothing here may say "ask
// your node operator" or "contact your operator" (../daybreak/daybreakCopy.ts,
// ../components/certExpiryNotice.ts). Pinned by ./editorCopy.test.ts with the
// same ban list.
//
// The Z's title, its unavailable headline and reason texts, the band-absent
// texts and the section headings are the MEMBER screen's, imported where the
// editor shows them — not restated here.

export const EDITOR_NAV_LABEL = "Daybreak Editor";
export const EDITOR_TITLE = "Daybreak Editor";
export const EDITOR_LOADING = "Loading the editions…";

export type Slot = "next" | "recent";

export const EDITION_LABEL: Record<Slot, string> = {
  next: "Next due edition",
  recent: "Most recent edition",
};

export const PUBLISHED_NOTE = "Published — members can see this edition.";
export const NOT_PUBLISHED_NOTE = "Not published yet.";
// The most recent edition, unpublished: the late-publish case (ruling (A)).
export const RECENT_NOT_LIVE_NOTE =
  "Not published yet — members are seeing an older edition, marked held over, until you publish this one.";
export const NO_DRAFT_NOTE = "There's no draft for this edition yet. Your first save creates it and computes the Z-Score.";

export function publishStatusCopy(slot: Slot, published: boolean): string {
  if (published) return PUBLISHED_NOTE;
  return slot === "recent" ? RECENT_NOT_LIVE_NOTE : NOT_PUBLISHED_NOTE;
}

export const Z_PENDING = "Computed on first save.";
// After a save reports an available Z, until the re-read brings its value.
export const Z_AVAILABLE_NO_DETAIL = "Computed. The score will show when the page refreshes.";

export function bandCopy(label: string): string {
  return `Band: ${label}`;
}

/** `date` is already formatted — a Central calendar date, never converted. */
export function closeAsOfCopy(asset: "Corn" | "Bitcoin", date: string): string {
  return `${asset}: as of ${date}'s close`;
}

export const FIELD_LABELS = {
  lead: "Lead",
  wrTitle: "Title",
  wrNote: "Note",
  wrLink: "Link (https://)",
  closer: "Closer",
} as const;

export const SAVE_LABEL = "Save";
export const SAVING_LABEL = "Saving…";
export const PUBLISH_LABEL = "Save and publish";
export const PUBLISHING_LABEL = "Publishing…";

export const SAVED = "Saved. Members won't see this until you publish.";
export const PUBLISHED = "Published. Members can see this edition now.";

const EDITING_OFF = "Editing is off until the editions load, so nothing can be overwritten unseen.";
export const LOAD_FAILED_GENERIC = `Couldn't load the editions. ${EDITING_OFF}`;

const LOAD_FAILED: Record<string, string> = {
  treasury_role_required: `The Daybreak Editor only works on the treasury node. ${EDITING_OFF}`,
  editor_not_configured: `The Daybreak Editor isn't set up on this node yet. ${EDITING_OFF}`,
  worker_not_configured: `This node is missing the address of BitCorn's services. ${EDITING_OFF}`,
  worker_auth_rejected: `BitCorn's Daybreak service didn't accept this node's editor key. ${EDITING_OFF}`,
  worker_unreachable: `This node couldn't reach BitCorn's Daybreak service just now. ${EDITING_OFF}`,
  worker_unavailable: `BitCorn's Daybreak service couldn't answer just now. ${EDITING_OFF}`,
};

const own = (o: Record<string, string>, k: unknown): string | undefined =>
  typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

/** A failed load → words. Only a recognised code gets its own; everything else is the generic message. */
export function loadFailedCopy(err: { code?: unknown } | null | undefined): string {
  return own(LOAD_FAILED, err?.code) ?? LOAD_FAILED_GENERIC;
}

const TEXT_KEPT = "Your text is still here.";
const NOTHING_PUBLISHED = "Nothing was published.";
const SAVE_FAILED_GENERIC = "Couldn't save.";

// Keyed by the Worker's refusal code (the proxy's editor_refused reason), or by
// the proxy's own code.
const SAVE_FAILED: Record<string, string> = {
  invalid_link: "Couldn't save: Worth Reading needs a full link starting with https://.",
  body_too_large: "Couldn't save: this edition is too long.",
  not_editable_date: "Couldn't save: this edition can no longer be edited, because a newer one is now due. Reload the page to see the current editions.",
  worker_unreachable: "Couldn't save: this node couldn't reach BitCorn's Daybreak service.",
  worker_unavailable: "Couldn't save: BitCorn's Daybreak service couldn't answer just now.",
};

/**
 * A failed save → words. `publishing` is true when the save was the first step
 * of Save and publish, so the words say that nothing was published.
 */
export function saveFailedCopy(err: { code?: unknown; body?: unknown } | null | undefined, publishing: boolean): string {
  const reason = err?.code === "editor_refused" ? (err.body as { reason?: unknown } | undefined)?.reason : err?.code;
  const head = own(SAVE_FAILED, reason) ?? SAVE_FAILED_GENERIC;
  return publishing ? `${head} ${NOTHING_PUBLISHED} ${TEXT_KEPT}` : `${head} ${TEXT_KEPT}`;
}

// The save succeeded; the publish after it did not.
export const PUBLISH_FAILED = "Saved, but not published. Your text is saved — try publishing again.";

/** Every string this module can produce, for the ban test. */
export function allEditorCopy(): string[] {
  return [
    EDITOR_NAV_LABEL,
    EDITOR_TITLE,
    EDITOR_LOADING,
    ...Object.values(EDITION_LABEL),
    PUBLISHED_NOTE,
    NOT_PUBLISHED_NOTE,
    RECENT_NOT_LIVE_NOTE,
    NO_DRAFT_NOTE,
    Z_PENDING,
    Z_AVAILABLE_NO_DETAIL,
    bandCopy("a band"),
    closeAsOfCopy("Corn", "Tuesday, October 6, 2026"),
    closeAsOfCopy("Bitcoin", "Tuesday, October 6, 2026"),
    ...Object.values(FIELD_LABELS),
    SAVE_LABEL,
    SAVING_LABEL,
    PUBLISH_LABEL,
    PUBLISHING_LABEL,
    SAVED,
    PUBLISHED,
    LOAD_FAILED_GENERIC,
    ...Object.values(LOAD_FAILED),
    ...[...Object.keys(SAVE_FAILED), "unknown"].flatMap((code) => [
      saveFailedCopy({ code }, false),
      saveFailedCopy({ code }, true),
    ]),
    PUBLISH_FAILED,
  ];
}
