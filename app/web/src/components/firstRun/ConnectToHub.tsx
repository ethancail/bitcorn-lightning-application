// ConnectToHub's markup, moved out of pages/MemberDashboard.tsx
// (member-first-run-ui separation slice, B.1). Its state and handlers are
// useConnectToHub.ts; its literals are connectToHubDescriptor.ts. Rendered by
// MemberDashboard at its no-channel panel and its upgrade banner.

import { useId } from "react";
import { useNavigate } from "react-router-dom";
import ActionConfirmModal from "../actionConfirm/ActionConfirmModal";
import { Choice } from "../Choice";
import TechnicalDetails, { TechRow } from "../TechnicalDetails";
import {
  ACTIVATE_MEMBERSHIP_PATH,
  CAPACITY_PRESETS,
  CONNECT_TO_HUB_COPY as COPY,
  FEE_SPEED_OPTIONS,
} from "./connectToHubDescriptor";
import { useConnectToHub } from "./useConnectToHub";

export { HUB_PUBKEY } from "./connectToHubDescriptor";

export default function ConnectToHub({ isPeered, initialCapacity }: { isPeered: boolean; initialCapacity?: number }) {
  const s = useConnectToHub({ isPeered, initialCapacity });
  const feeId = useId();
  const navigate = useNavigate();

  if (s.success) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="alert healthy">
          <span className="alert-icon">✓</span>
          <div className="alert-body">
            <div className="alert-type">{COPY.submittedTitle}</div>
            <div className="alert-msg">
              {COPY.submittedMessage}
            </div>
          </div>
        </div>
        {s.success !== "submitted" && (
          <div>
            <div
              style={{
                fontSize: "0.75rem",
                color: "var(--text-3)",
                fontFamily: "var(--mono)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: 6,
              }}
            >
              {COPY.fundingTransaction}
            </div>
            <div
              style={{
                background: "var(--bg-3)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "8px 12px",
                fontFamily: "var(--mono)",
                fontSize: "0.75rem",
                wordBreak: "break-all",
                color: "var(--text-1)",
              }}
            >
              {s.success}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Info alert */}
      <div className="alert info" style={{ marginBottom: 0 }}>
        <span className="alert-icon">◈</span>
        <div className="alert-body">
          <div className="alert-type">{COPY.noHubTitle}</div>
          <div className="alert-msg">
            {COPY.noHubMessage}
          </div>
          {/* membership-gating B1: only on the treasury's verdict false. Goes
              to Settings' membership section; mounts no payment modal. Kept
              inside this alert, as its last child, so it shifts no sibling's
              position (the states snapshot pins the reconciled DOM). */}
          {s.membershipLocked && (
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginTop: 10 }}
              onClick={() => navigate(ACTIVATE_MEMBERSHIP_PATH)}
            >
              {s.membershipLabel}
            </button>
          )}
        </div>
      </div>

      {/* Open channel form */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label className="form-label">{COPY.capacityLabel}</label>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            {CAPACITY_PRESETS.map((p) => (
              <button
                key={p.value}
                className={`btn ${s.capacity === p.value ? "btn-primary" : "btn-outline"}`}
                onClick={() => s.setCapacity(p.value)}
                style={{ flex: 1 }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div style={{ position: "relative" }}>
            <input
              aria-label={COPY.capacityAriaLabel}
              className="form-input"
              type="text"
              inputMode="numeric"
              value={s.capacity.toLocaleString()}
              onChange={(e) => s.setCapacityFromInput(e.target.value)}
              style={{ paddingRight: 42 }}
            />
            <span style={{
              position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
              fontSize: "0.75rem", color: "var(--text-3)", fontFamily: "var(--mono)", pointerEvents: "none",
            }}>
              {COPY.satsUnit}
            </span>
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: 4 }}>
            {COPY.capacityHint}
          </div>
          {s.belowMinimum && (
            <div style={{ fontSize: "0.75rem", color: "var(--red)", marginTop: 4 }}>
              {COPY.capacityBelowMinimum}
            </div>
          )}
        </div>

        {/* Peering section — 3 states based on actual LND peer connection + Worker socket */}
        {isPeered ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              background: "color-mix(in srgb, var(--green) 10%, var(--bg-2))",
              border: "1px solid color-mix(in srgb, var(--green) 30%, transparent)",
              borderRadius: 6,
              fontSize: "0.8125rem",
              color: "var(--green)",
            }}
          >
            <span>✓</span>
            <span>{COPY.peered}</span>
          </div>
        ) : s.hasAutoSocket ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              background: "color-mix(in srgb, var(--amber) 10%, var(--bg-2))",
              border: "1px solid color-mix(in srgb, var(--amber) 30%, transparent)",
              borderRadius: 6,
              fontSize: "0.8125rem",
              color: "var(--text)",
            }}
          >
            <span style={{ color: "var(--amber)" }}>◈</span>
            <span>{COPY.autoSocket}</span>
          </div>
        ) : s.treasuryInfoLoading ? (
          <div className="loading-shimmer" style={{ height: 40, borderRadius: 6 }} />
        ) : (
          <div>
            <label className="form-label">
              {COPY.hubAddressLabel}{" "}
              <span style={{ color: "var(--text-3)", fontWeight: 400 }}>{COPY.optional}</span>
            </label>
            <input
              aria-label={COPY.hubAddressAriaLabel}
              className="form-input"
              type="text"
              placeholder={COPY.hubAddressPlaceholder}
              value={s.socket}
              onChange={(e) => s.setSocket(e.target.value)}
            />
            <div style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: 4 }}>
              {COPY.hubAddressHint}
            </div>
          </div>
        )}

        {s.error && (
          <div className="alert critical">
            <span className="alert-icon">✕</span>
            <div className="alert-body">
              <div className="alert-msg">{s.error}</div>
            </div>
          </div>
        )}

        {/* Fee rate selector */}
        <div>
          <div className="form-label" id={`${feeId}-label`}>{COPY.confirmationSpeed}</div>
          {/* String keys mapped to rates; Economy's rate is undefined. */}
          <Choice
            name={`${feeId}-speed`}
            labelledBy={`${feeId}-label`}
            value={FEE_SPEED_OPTIONS.find((o) => o.rate === s.feeRate)?.key ?? null}
            onChange={(key) => s.setFeeRate(FEE_SPEED_OPTIONS.find((o) => o.key === key)?.rate)}
            options={FEE_SPEED_OPTIONS.map((opt) => ({ value: opt.key, label: opt.label, description: opt.time, meta: opt.cost }))}
          />
        </div>

        <button
          className="btn btn-primary"
          onClick={s.openChannelConfirm}
          disabled={s.openDisabled}
        >
          {s.submitting ? COPY.connecting : COPY.openChannel}
        </button>

        <ActionConfirmModal controller={s.confirm} onConfirm={s.handleOpen} />
      </div>

      {/* Protocol reference — demoted per U2 (vocabulary record 2026-07-09) */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <TechnicalDetails>
          <TechRow label={COPY.hubNodeId}><span className="ident">{s.hubPubkey}</span></TechRow>
          <TechRow label={COPY.feeRates}>{COPY.feeRatesDetail}</TechRow>
        </TechnicalDetails>
      </div>
    </div>
  );
}
