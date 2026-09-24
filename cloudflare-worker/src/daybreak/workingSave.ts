// Daybreak WORKING SAVE — Kevin's save from the treasury editor (spec §3.4.1).
//
// The editor sends only Kevin's written sections. The Worker-owned fields
// (everything under WORKER_OWNED_KEY: the Z block and both close dates) are
// taken SERVER-SIDE (I.1), and the editor has no way to set them: anything it
// puts under the reserved key is DISCARDED.
//
// ⚠ AN AVAILABLE Z PINS; AN UNAVAILABLE ONE DOES NOT (J.3, K.1). If the
// working key has no reserved block yet, OR its Z block is unavailable, the
// save copies the reserved block from the current draft. Once it holds an
// AVAILABLE Z, every later save keeps the working key's own block and does NOT
// re-read the draft — so a drafting-agent re-run between two saves cannot
// change the numbers under Kevin's text, while an outage at the first save
// recovers on the next save after a successful re-run.
//
// ⚠ PER-PIECE PINNING (ruled 2026-09-24) supersedes K.1's whole-block re-copy
// in part. Today the block holds exactly one piece — the Z with its two close
// dates — so the two are identical. When market tiles join the block, each
// tile must pin on its own and this whole-block copy must change.
//
// ⚠ NO DRAFT when one must be copied is an explicit error, "no_draft", and
// nothing is written. What should happen instead is OPEN — reserved to Ethan
// (§7). A draft that lacks the reserved key (written around intake) is refused
// the same way: this save never invents Worker-owned fields.

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

// Anything short of a well-formed available Z block is treated as not pinned,
// so the save falls back to the Worker-written draft — never to the editor.
function holdsAvailableZ(content: EditionContent): boolean {
  const owned = content[WORKER_OWNED_KEY];
  if (!isPlainObject(owned) || !isPlainObject(owned.z)) return false;
  return owned.z.status === "available";
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
  if (working.found && holdsAvailableZ(working.content)) {
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
