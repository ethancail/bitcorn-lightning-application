// BitCorn Daybreak — the member screen (bitcorn-research spec §3.4.3;
// decisions/2026-09-25-daybreak-member-screen-seven-rulings.md).
//
// ROLE-BLIND, like ./Charts.tsx: no role check, no shell props, no router
// dependency, and a plain polling hook rather than React Query — so the
// treasury shell can mount this same component later for a preview. It is
// registered in the member shell only for now.
//
// Sections are PLAIN TEXT split into paragraphs (Ruling 5). Nothing from an
// edition is ever parsed as markup: every string reaches the DOM as a React
// text node. Worth Reading's link is a link only when its scheme is https.
//
// It inherits the member's font, text scale and theme (spec §3.5): nothing
// here sets --mono, --sans, --text-scale or data-theme.

import DaybreakGauge from "../daybreak/DaybreakGauge";
import {
  CLOSER_SIGNATURE,
  DAYBREAK_TITLE,
  HELD_OVER_MARK,
  HELD_OVER_NOTE,
  LOADING_TEXT,
  NO_EDITION,
  SECTION_HEADINGS,
  Z_UNAVAILABLE_HEADLINE,
  closesCopy,
  daybreakErrorCopy,
  zUnavailableCopy,
  type Copy,
} from "../daybreak/daybreakCopy";
import { formatCentralDate, type EditionView, type SectionsView } from "../daybreak/daybreakView";
import { useDaybreakEdition } from "../daybreak/useDaybreakEdition";

function Notice({ copy, testId }: { copy: Copy; testId: string }) {
  return (
    <div className="panel" data-testid={testId}>
      <div className="panel-body">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{copy.headline}</div>
        <div style={{ fontSize: "0.875rem", color: "var(--text-2)" }}>{copy.body}</div>
      </div>
    </div>
  );
}

function Paragraphs({ items }: { items: string[] }) {
  return (
    <>
      {items.map((p, i) => (
        <p key={i} style={{ whiteSpace: "pre-line", lineHeight: 1.6, marginTop: i === 0 ? 0 : 10 }}>
          {p}
        </p>
      ))}
    </>
  );
}

function Section({ id, heading, children }: { id: keyof SectionsView; heading?: string; children: React.ReactNode }) {
  return (
    <section data-testid={`daybreak-section-${id}`} style={{ marginTop: 20 }}>
      {heading && <h2 style={{ marginBottom: 8 }}>{heading}</h2>}
      {children}
    </section>
  );
}

function Edition({ edition }: { edition: EditionView }) {
  const { sections: s, z } = edition;
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <span data-testid="daybreak-date" style={{ color: "var(--text-2)", fontSize: "0.875rem" }}>
          {formatCentralDate(edition.date)}
        </span>
        {edition.state === "held_over" && (
          <span data-testid="daybreak-held-over" style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="badge badge-amber">{HELD_OVER_MARK}</span>
            <span style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>{HELD_OVER_NOTE}</span>
          </span>
        )}
      </div>

      <div className="panel">
        <div className="panel-body">
          {z.status === "available" ? (
            <>
              <DaybreakGauge value={z.value} bands={z.bands} />
              <div style={{ textAlign: "center", fontSize: "0.75rem", color: "var(--text-3)", marginTop: 10 }}>
                {closesCopy(formatCentralDate(z.corn.date), formatCentralDate(z.btc.date))}
              </div>
            </>
          ) : (
            <div style={{ textAlign: "center" }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{Z_UNAVAILABLE_HEADLINE}</div>
              <div style={{ fontSize: "0.875rem", color: "var(--text-3)" }}>{zUnavailableCopy(z.reason)}</div>
            </div>
          )}
        </div>
      </div>

      {s.lead && (
        <Section id="lead">
          <Paragraphs items={s.lead} />
        </Section>
      )}
      {s.kevinsRead && (
        <Section id="kevinsRead" heading={SECTION_HEADINGS.kevinsRead}>
          <Paragraphs items={s.kevinsRead} />
        </Section>
      )}
      {s.insideAgriculture && (
        <Section id="insideAgriculture" heading={SECTION_HEADINGS.insideAgriculture}>
          <Paragraphs items={s.insideAgriculture} />
        </Section>
      )}
      {s.worthReading && (
        <Section id="worthReading" heading={SECTION_HEADINGS.worthReading}>
          {s.worthReading.title && (
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              {s.worthReading.href ? (
                <a href={s.worthReading.href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--amber)" }}>
                  {s.worthReading.title}
                </a>
              ) : (
                s.worthReading.title
              )}
            </div>
          )}
          {s.worthReading.note && <Paragraphs items={s.worthReading.note} />}
          {!s.worthReading.title && s.worthReading.href && (
            <a href={s.worthReading.href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--amber)", wordBreak: "break-all" }}>
              {s.worthReading.href}
            </a>
          )}
        </Section>
      )}
      {s.closer && (
        <Section id="closer">
          <Paragraphs items={s.closer} />
          <div style={{ marginTop: 12, fontFamily: "var(--mono)", fontSize: "0.75rem", letterSpacing: "0.08em", color: "var(--text-3)" }}>
            {CLOSER_SIGNATURE}
          </div>
        </Section>
      )}
    </>
  );
}

export default function Daybreak() {
  const state = useDaybreakEdition();

  let body: React.ReactNode;
  if (state.status === "loading") {
    body = (
      <div className="panel">
        <div className="panel-body" style={{ color: "var(--text-3)", fontSize: "0.875rem" }}>
          {LOADING_TEXT}
        </div>
      </div>
    );
  } else if (state.status === "failed") {
    body = <Notice copy={daybreakErrorCopy(state.failure)} testId="daybreak-error" />;
  } else if (state.read.state === "unavailable") {
    body = <Notice copy={NO_EDITION} testId="daybreak-no-edition" />;
  } else {
    body = <Edition edition={state.read} />;
  }

  return (
    <div className="fade-in" style={{ maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 12 }}>{DAYBREAK_TITLE}</h1>
      {body}
    </div>
  );
}
