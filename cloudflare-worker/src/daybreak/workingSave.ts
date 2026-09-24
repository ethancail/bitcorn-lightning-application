// Daybreak WORKING SAVE — Kevin's save from the treasury editor (spec §3.4.1).
//
// The editor sends only Kevin's written sections. The Worker-owned fields
// (everything under WORKER_OWNED_KEY: the Z block and both close dates) are
// taken SERVER-SIDE (I.1), and the editor has no way to set them: anything it
// puts under the reserved key is DISCARDED.
//
// ⚠ COPY ONCE (J.3). The FIRST save for an edition date copies the reserved
// key from the current draft. Every LATER save keeps the working key's own
// reserved key and does NOT re-read the draft — so a drafting-agent re-run
// between two saves cannot change the numbers under Kevin's text. J's record
// flags the consequence: an unavailable Z captured at the first save is kept
// too; recovery waits on the undecided "start over from the latest draft"
// action (§7).
//
// ⚠ NO DRAFT AT THE FIRST SAVE is an explicit error, "no_draft", and nothing
// is written. What should happen instead is OPEN — reserved to Ethan (§7).
// A draft or working key that lacks the reserved key (written around intake)
// is refused the same way: this save never invents Worker-owned fields.

import { isCentralDate, type CentralDate } from "./dates";
import { WORKER_OWNED_KEY } from "./intake";
import { readDraft, readWorking, writeWorking, type DaybreakStoreError, type EditionContent } from "./store";

export type WorkingSaveResult =
  | { ok: true; workerOwnedFrom: "draft" | "working" }
  | { ok: false; reason: "no_draft" | "missing_worker_owned"; detail: string }
  | DaybreakStoreError;

function isPlainObject(v: unknown): v is EditionContent {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export async function saveWorking(kv: KVNamespace, date: CentralDate, content: EditionContent): Promise<WorkingSaveResult> {
  if (!isCentralDate(date)) {
    return { ok: false, reason: "invalid_date", detail: `an explicit YYYY-MM-DD Central edition date is required, got ${String(date)}` };
  }
  if (!isPlainObject(content)) {
    return { ok: false, reason: "invalid_content", detail: "edition content must be a plain JSON object" };
  }

  const working = await readWorking(kv, date);
  if (!working.ok) return working;

  let from: "draft" | "working" = "working";
  let source: EditionContent;
  if (working.found) {
    source = working.content;
  } else {
    const draft = await readDraft(kv, date);
    if (!draft.ok) return draft;
    if (!draft.found) {
      return { ok: false, reason: "no_draft", detail: `no draft exists for ${date}, so there are no Worker-owned fields to copy` };
    }
    from = "draft";
    source = draft.content;
  }

  const owned = source[WORKER_OWNED_KEY];
  if (!isPlainObject(owned)) {
    return { ok: false, reason: "missing_worker_owned", detail: `the ${from} for ${date} carries no ${WORKER_OWNED_KEY} key` };
  }

  const { [WORKER_OWNED_KEY]: _discarded, ...sections } = content;
  const written = await writeWorking(kv, date, { ...sections, [WORKER_OWNED_KEY]: owned });
  if (!written.ok) return written;
  return { ok: true, workerOwnedFrom: from };
}
