// The Daybreak Editor — Kevin's CMS, a treasury page (spec §3.4.5, "THE EDITOR
// SCREEN"). Phone-first with its own layout: one column, each section a
// full-width field, Worth Reading's three fields together (R11).
//
// ⚠ DayForm's BEHAVIOUR, followed — not its grid, and nothing imported from it
// or from components/autoBuy/ (components/valuation/DayForm.tsx):
//   - a cancel-aware load, re-run by Retry;
//   - U24 M2: no editable form while loading or after a failed load, so the
//     save path is unreachable then;
//   - inputs and both buttons disabled while busy;
//   - a re-read after a save.
//
// ⚠ THE EDITIONS COME FROM THE WORKER. The read returns the next due edition
// (the default) and the most recent one; the browser computes no date. Every
// date shown is a US Central calendar date, rendered as written
// (formatCentralDate), never converted. No instant is shown: no publish time,
// no "updated" mark.
//
// ⚠ PUBLISH SAVES FIRST (ruling (B)): Save and publish sends the form as a
// SAVE, and sends the publish only after the save succeeds. A failed save
// sends no publish.
//
// The page checks no role itself, like every treasury page: assertTreasury on
// the proxies enforces it.

import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import ErrorState from "../components/ErrorState";
import {
  SECTION_HEADINGS,
  Z_TITLE,
  Z_UNAVAILABLE_HEADLINE,
  bandsUnavailableCopy,
  zUnavailableCopy,
} from "../daybreak/daybreakCopy";
import { formatCentralDate, formatZ } from "../daybreak/daybreakView";
import {
  EDITION_LABEL,
  EDITOR_LOADING,
  EDITOR_TITLE,
  FIELD_LABELS,
  NO_DRAFT_NOTE,
  PUBLISH_FAILED,
  PUBLISH_LABEL,
  PUBLISHED,
  PUBLISHING_LABEL,
  SAVE_LABEL,
  SAVED,
  SAVING_LABEL,
  Z_AVAILABLE_NO_DETAIL,
  Z_PENDING,
  bandCopy,
  closeAsOfCopy,
  loadFailedCopy,
  publishStatusCopy,
  saveFailedCopy,
  type Slot,
} from "../daybreakEditor/editorCopy";
import {
  formToSections,
  parseEditorRead,
  worthReadingIsPartial,
  zAfterSave,
  type EditorEdition,
  type EditorRead,
  type EditorZ,
  type FormValues,
} from "../daybreakEditor/editorView";

type Toast = { kind: "success" | "error"; msg: string };

const fieldStyle = { width: "100%", boxSizing: "border-box" as const, fontFamily: "var(--sans)", fontSize: "1rem" };
const textareaStyle = { ...fieldStyle, minHeight: "7rem", resize: "vertical" as const, lineHeight: 1.5 };

function ZStatus({ z }: { z: EditorZ }) {
  let body: ReactNode;
  if (z.kind === "pending") body = <div>{Z_PENDING}</div>;
  else if (z.kind === "available_no_detail") body = <div>{Z_AVAILABLE_NO_DETAIL}</div>;
  else if (z.z.status === "unavailable") {
    body = (
      <>
        <div style={{ fontWeight: 600 }}>{Z_UNAVAILABLE_HEADLINE}</div>
        <div style={{ color: "var(--text-2)" }}>{zUnavailableCopy(z.z.reason)}</div>
      </>
    );
  } else {
    const { value, corn, btc, bands } = z.z;
    body = (
      <>
        <div data-testid="editor-z-value" style={{ fontFamily: "var(--mono)", fontSize: "1.75rem", fontWeight: 600 }}>
          {formatZ(value)}
        </div>
        <div data-testid="editor-z-band">
          {bands.status === "available" ? bandCopy(bands.table[bands.index].label) : bandsUnavailableCopy(bands.reason)}
        </div>
        <div data-testid="editor-z-close" style={{ color: "var(--text-2)" }}>
          {closeAsOfCopy("Corn", formatCentralDate(corn.date))}
        </div>
        <div data-testid="editor-z-close" style={{ color: "var(--text-2)" }}>
          {closeAsOfCopy("Bitcoin", formatCentralDate(btc.date))}
        </div>
      </>
    );
  }
  return (
    <section data-testid="editor-z-status" className="panel" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="form-label">{Z_TITLE}</div>
      {body}
    </section>
  );
}

export default function DaybreakEditor() {
  const [read, setRead] = useState<EditorRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ code?: unknown } | null>(null);
  // Bumping this re-runs the load effect — the Retry action on a failed load.
  const [reloadNonce, setReloadNonce] = useState(0);
  const [selected, setSelected] = useState<Slot>("next");
  // Kevin's text, per edition date, so switching editions keeps unsaved edits.
  const [forms, setForms] = useState<Record<string, FormValues>>({});
  const [busy, setBusy] = useState<null | "save" | "publish">(null);
  const [toast, setToast] = useState<Toast | null>(null);

  // A read → state. `keep` keeps the forms already on screen for dates the
  // read still holds — after a save they ARE the stored copy, and the other
  // edition's unsaved text survives.
  const apply = (r: EditorRead, keep: boolean) => {
    setRead(r);
    setForms((prev) => {
      const next: Record<string, FormValues> = {};
      for (const e of [r.next, r.recent]) next[e.date] = keep && prev[e.date] ? prev[e.date] : e.form;
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setRead(null);
    api
      .getDaybreakEditor()
      .then((raw) => {
        if (cancelled) return;
        const parsed = parseEditorRead(raw);
        if (parsed) {
          apply(parsed, false);
          setSelected("next");
        } else setLoadError({});
        setLoading(false);
      })
      .catch((err: { code?: unknown }) => {
        if (cancelled) return;
        setLoadError(err ?? {});
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // apply only consumes setters, which are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadNonce]);

  // Post-save re-read. Fire-and-forget: on failure the screen keeps what the
  // save's own response already told it.
  const refresh = () => {
    api
      .getDaybreakEditor()
      .then((raw) => {
        const parsed = parseEditorRead(raw);
        if (parsed) apply(parsed, true);
      })
      .catch((err) => console.error("[DaybreakEditor:refresh]", err));
  };

  // U24 M2: no form on a pending or failed load — the save path is unreachable.
  if (loading) {
    return (
      <div data-testid="editor-loading" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h1 style={{ marginBottom: 12 }}>{EDITOR_TITLE}</h1>
        <div style={{ color: "var(--text-2)" }}>{EDITOR_LOADING}</div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="loading-shimmer" style={{ height: 44, borderRadius: 6 }} />
        ))}
      </div>
    );
  }
  if (loadError !== null || !read) {
    return (
      <div data-testid="editor-load-failed">
        <h1 style={{ marginBottom: 12 }}>{EDITOR_TITLE}</h1>
        <ErrorState bare message={loadFailedCopy(loadError)} onRetry={() => setReloadNonce((n) => n + 1)} />
      </div>
    );
  }

  const edition: EditorEdition = read[selected];
  const form = forms[edition.date] ?? edition.form;
  const disabled = busy !== null;
  const setField = (name: keyof FormValues, value: string) =>
    setForms((prev) => ({ ...prev, [edition.date]: { ...(prev[edition.date] ?? edition.form), [name]: value } }));

  // The selected edition's state after a successful save or publish.
  const update = (date: string, change: (e: EditorEdition) => EditorEdition) =>
    setRead((r) => (r ? { next: r.next.date === date ? change(r.next) : r.next, recent: r.recent.date === date ? change(r.recent) : r.recent } : r));

  const save = async (date: string, values: FormValues, publishing: boolean): Promise<boolean> => {
    // A partly filled Worth Reading is refused here, before anything is sent.
    if (worthReadingIsPartial(values)) {
      setToast({ kind: "error", msg: saveFailedCopy({ code: "worth_reading_incomplete" }, publishing) });
      return false;
    }
    try {
      const res = await api.saveDaybreakEdition({ date, sections: formToSections(values) });
      update(date, (e) => ({ ...e, hasCopy: true, z: zAfterSave(res, e.z) }));
      return true;
    } catch (err) {
      setToast({ kind: "error", msg: saveFailedCopy(err as { code?: unknown; body?: unknown }, publishing) });
      return false;
    }
  };

  const onSave = async () => {
    const { date } = edition;
    setBusy("save");
    setToast(null);
    const ok = await save(date, form, false);
    if (ok) setToast({ kind: "success", msg: SAVED });
    setBusy(null);
    if (ok) refresh();
  };

  // Publish saves first; the publish is sent only after the save succeeds.
  const onPublish = async () => {
    const { date } = edition;
    setBusy("publish");
    setToast(null);
    if (!(await save(date, form, true))) {
      setBusy(null);
      return;
    }
    try {
      await api.publishDaybreakEdition({ date });
      update(date, (e) => ({ ...e, published: true }));
      setToast({ kind: "success", msg: PUBLISHED });
    } catch {
      setToast({ kind: "error", msg: PUBLISH_FAILED });
    }
    setBusy(null);
    refresh();
  };

  const textSection = (name: "lead" | "kevinsRead" | "insideAgriculture" | "closer", label: string) => (
    <div key={name} data-testid="editor-section" data-section={name} className="form-group">
      <label className="form-label" htmlFor={`editor-${name}`}>{label}</label>
      <textarea
        id={`editor-${name}`}
        data-field={name}
        className="form-input"
        style={textareaStyle}
        value={form[name]}
        disabled={disabled}
        onChange={(e) => setField(name, e.target.value)}
      />
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: "42rem", width: "100%" }}>
      <h1 style={{ marginBottom: 0 }}>{EDITOR_TITLE}</h1>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {(["next", "recent"] as const).map((slot) => (
          <button
            key={slot}
            type="button"
            data-testid="editor-edition-choice"
            data-slot={slot}
            aria-pressed={selected === slot}
            className={`btn ${selected === slot ? "btn-primary" : "btn-outline"}`}
            disabled={disabled}
            onClick={() => {
              setSelected(slot);
              setToast(null);
            }}
          >
            {EDITION_LABEL[slot]}
          </button>
        ))}
      </div>

      <div>
        <div data-testid="editor-edition-date" style={{ fontWeight: 600, fontSize: "1.125rem" }}>
          {EDITION_LABEL[edition.slot]}: {formatCentralDate(edition.date)}
        </div>
        <div data-testid="editor-publish-status" style={{ color: "var(--text-2)" }}>
          {publishStatusCopy(edition.slot, edition.published)}
        </div>
      </div>

      <ZStatus z={edition.z} />

      {!edition.hasCopy && (
        <div data-testid="editor-no-draft" style={{ color: "var(--text-2)" }}>{NO_DRAFT_NOTE}</div>
      )}

      {textSection("lead", FIELD_LABELS.lead)}
      {textSection("kevinsRead", SECTION_HEADINGS.kevinsRead)}
      {textSection("insideAgriculture", SECTION_HEADINGS.insideAgriculture)}

      <fieldset
        data-testid="editor-section"
        data-section="worthReading"
        disabled={disabled}
        style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 12, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}
      >
        <legend className="form-label" style={{ padding: "0 4px" }}>{SECTION_HEADINGS.worthReading}</legend>
        <div className="form-group">
          <label className="form-label" htmlFor="editor-wrTitle">{FIELD_LABELS.wrTitle}</label>
          <input id="editor-wrTitle" data-field="wrTitle" className="form-input" style={fieldStyle} value={form.wrTitle} disabled={disabled} onChange={(e) => setField("wrTitle", e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="editor-wrNote">{FIELD_LABELS.wrNote}</label>
          <textarea id="editor-wrNote" data-field="wrNote" className="form-input" style={textareaStyle} value={form.wrNote} disabled={disabled} onChange={(e) => setField("wrNote", e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="editor-wrLink">{FIELD_LABELS.wrLink}</label>
          <input id="editor-wrLink" data-field="wrLink" type="url" inputMode="url" autoCapitalize="off" className="form-input" style={fieldStyle} value={form.wrLink} disabled={disabled} onChange={(e) => setField("wrLink", e.target.value)} />
        </div>
      </fieldset>

      {textSection("closer", FIELD_LABELS.closer)}

      {toast && (
        <div
          data-testid="editor-toast"
          data-kind={toast.kind}
          className={`sub-alert ${toast.kind === "success" ? "sub-alert-emerald" : "sub-alert-dim-red"}`}
        >
          <div className="sub-alert-body">{toast.msg}</div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" data-testid="editor-save" className="btn btn-outline" style={{ width: "100%" }} disabled={disabled} onClick={onSave}>
          {busy === "save" ? SAVING_LABEL : SAVE_LABEL}
        </button>
        <button type="button" data-testid="editor-publish" className="btn btn-primary" style={{ width: "100%" }} disabled={disabled} onClick={onPublish}>
          {busy === "publish" ? PUBLISHING_LABEL : PUBLISH_LABEL}
        </button>
      </div>
    </div>
  );
}
