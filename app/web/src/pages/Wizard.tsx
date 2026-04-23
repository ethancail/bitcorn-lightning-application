import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api, type NodeInfo } from "../api/client";

type WizardData = {
  detectedPubkey: string;
  feeRatePpm: number;
  minOnchainReserveSats: number;
  maxDeployRatioPct: number;
  maxDailyLossSats: number;
};

function truncPubkey(pk: string) {
  if (!pk || pk.length < 20) return pk;
  return `${pk.slice(0, 12)}…${pk.slice(-6)}`;
}

function StepLine({ current, total }: { current: number; total: number }) {
  const labels = ["Detect node", "Base fee rate", "Capital guardrails", "Review & launch"];
  return (
    <div className="wizard-step-rail" role="list">
      {labels.slice(0, total).map((label, i) => {
        const state = i < current ? "done" : i === current ? "active" : "future";
        const num = String(i + 1).padStart(2, "0");
        return (
          <div
            key={label}
            className={`wizard-rail-item ${state}`}
            role="listitem"
            aria-current={state === "active" ? "step" : undefined}
            aria-label={state === "done" ? `${label} — complete` : undefined}
          >
            <span className="num">{num}</span>
            <span className="dot" />
            <span className="lbl">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Screen 1: LND Connection ─────────────────────────────────────────────

function Screen1({
  onNext,
  onNodeDetected,
}: {
  onNext: () => void;
  onNodeDetected: (pubkey: string) => void;
}) {
  const [node, setNode] = useState<NodeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getNode()
      .then((n) => {
        setNode(n);
        onNodeDetected(n.pubkey ?? "");
        setLoading(false);
      })
      .catch(() => {
        setError("Cannot reach the API. Make sure the node is running.");
        setLoading(false);
      });
  }, []);

  const synced = node?.synced_to_chain === 1;

  return (
    <div className="wizard-screen fade-in">
      <div className="wizard-title">LND Connection</div>
      <div className="wizard-subtitle">Checking your Lightning node status.</div>

      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[80, 120, 60].map((w, i) => (
            <div key={i} className="loading-shimmer" style={{ height: 20, width: `${w}%` }} />
          ))}
        </div>
      )}

      {error && (
        <div className="alert warning">
          <span className="alert-icon">⚠</span>
          <div className="alert-body">
            <div className="alert-type">API unreachable</div>
            <div className="alert-msg">{error} You can still proceed — config will be validated on the final step.</div>
          </div>
        </div>
      )}

      {!loading && node && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div
            style={{
              background: "var(--bg-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "16px 18px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <Row label="Alias" value={node.alias || "—"} />
            <Row label="Pubkey" value={truncPubkey(node.pubkey)} mono />
            <Row label="Block Height" value={node.block_height?.toLocaleString() ?? "—"} mono />
            <Row
              label="Sync Status"
              value={
                synced ? (
                  <span className="badge badge-green">synced</span>
                ) : (
                  <span className="badge badge-red">not synced</span>
                )
              }
            />
          </div>

          {!synced && (
            <div className="alert warning">
              <span className="alert-icon">⚠</span>
              <div className="alert-body">
                <div className="alert-msg">
                  Node is not synced to chain. Wait for sync before proceeding.
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {!loading && node && (
        <div className="alert info" style={{ marginTop: 12 }}>
          <span className="alert-icon">ℹ</span>
          <div className="alert-body">
            <div className="alert-msg">
              <code style={{ fontFamily: "var(--mono)" }}>TREASURY_PUBKEY</code> is an environment variable managed by Umbrel — it cannot be changed from the UI. Set it to the pubkey above in your Umbrel app settings before proceeding.
            </div>
          </div>
        </div>
      )}

      <div className="wizard-footer" style={{ borderRadius: "0 0 12px 12px" }}>
        <span />
        <button
          className="btn btn-primary"
          disabled={loading}
          onClick={onNext}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

// ─── Screen 2: Base Fee Rate ──────────────────────────────────────────────

function Screen2({
  data,
  onChange,
  onNext,
  onBack,
}: {
  data: WizardData;
  onChange: (v: Partial<WizardData>) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const val = data.feeRatePpm;
  const valid = val >= 1 && val <= 10000;

  return (
    <div className="wizard-screen fade-in">
      <div className="wizard-title">Base Fee Rate</div>
      <div className="wizard-subtitle">Set the routing fee rate the dynamic engine scales from.</div>

      <div className="form-group">
        <label className="form-label">Base Fee Rate (ppm)</label>
        <input
          className={`form-input${!valid ? " has-error" : ""}`}
          type="number"
          min={1}
          max={10000}
          value={val}
          onChange={(e) => onChange({ feeRatePpm: Number(e.target.value) })}
        />
        <span className="form-helper">
          The dynamic fee engine scales this 0.25×–4.0× per channel based on liquidity
          health. 500 ppm is a safe starting point. Range: 1–10,000.
        </span>
      </div>

      <div
        style={{
          background: "var(--bg-3)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "14px 16px",
        }}
      >
        <div className="form-label" style={{ marginBottom: 10 }}>Effective Range</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {[
            { label: "Critical (0.25×)", val: Math.round(val * 0.25) },
            { label: "Healthy (1.0×)", val: val },
            { label: "Starved (4.0×)", val: Math.min(10000, Math.round(val * 4)) },
          ].map((row) => (
            <div key={row.label}>
              <div className="stat-label">{row.label}</div>
              <div
                className="stat-value"
                style={{ fontSize: "1rem", color: "var(--amber)" }}
              >
                {row.val} ppm
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="wizard-footer" style={{ borderRadius: "0 0 12px 12px" }}>
        <button className="btn btn-ghost" onClick={onBack}>← Back</button>
        <button
          className="btn btn-primary"
          disabled={!valid}
          onClick={onNext}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

// ─── Screen 3: Capital Policy ─────────────────────────────────────────────

function Screen3({
  data,
  onChange,
  onNext,
  onBack,
}: {
  data: WizardData;
  onChange: (v: Partial<WizardData>) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const fields = [
    {
      key: "minOnchainReserveSats" as const,
      label: "Min On-Chain Reserve (sats)",
      helper: "Guardrails won't let automation open channels if on-chain balance drops below this floor.",
      min: 0,
    },
    {
      key: "maxDeployRatioPct" as const,
      label: "Max Deploy Ratio (%)",
      helper: "Max % of total funds that can be deployed into channels. Keeps a safety buffer on-chain.",
      min: 1,
      max: 100,
    },
    {
      key: "maxDailyLossSats" as const,
      label: "Max Daily Loss Cap (sats)",
      helper: "Automation halts if rebalance fees exceed this in a 24h window. Protects against runaway rebalancing.",
      min: 0,
    },
  ];

  return (
    <div className="wizard-screen fade-in">
      <div className="wizard-title">Capital Policy</div>
      <div className="wizard-subtitle">Define the guardrails that protect your deployed capital.</div>

      {fields.map((f) => (
        <div className="form-group" key={f.key}>
          <label className="form-label">{f.label}</label>
          <input
            className="form-input"
            type="number"
            min={f.min ?? 0}
            max={f.max}
            value={data[f.key]}
            onChange={(e) => onChange({ [f.key]: Number(e.target.value) })}
          />
          <span className="form-helper">{f.helper}</span>
        </div>
      ))}

      <div className="wizard-footer" style={{ borderRadius: "0 0 12px 12px" }}>
        <button className="btn btn-ghost" onClick={onBack}>← Back</button>
        <button className="btn btn-primary" onClick={onNext}>
          Next →
        </button>
      </div>
    </div>
  );
}

// ─── Screen 4: Confirmation ───────────────────────────────────────────────

function Screen4({
  data,
  onBack,
  onConfirm,
  saving,
  error,
}: {
  data: WizardData;
  onBack: () => void;
  onConfirm: () => void;
  saving: boolean;
  error: string | null;
}) {
  // Hub pubkey is displayed as a single smaller reference card above
  // the policy cards (no unit, truncated mono value).
  const policyCards: Array<{ label: string; meta: string; value: string; unit: string }> = [
    {
      label: "Base Fee Rate",
      meta: "Routing fee (ppm)",
      value: data.feeRatePpm.toLocaleString(),
      unit: "ppm",
    },
    {
      label: "Min On-Chain Reserve",
      meta: "Floor for automated opens",
      value: data.minOnchainReserveSats.toLocaleString(),
      unit: "sats",
    },
    {
      label: "Max Deploy Ratio",
      meta: "Share of funds deployable",
      value: String(data.maxDeployRatioPct),
      unit: "%",
    },
    {
      label: "Max Daily Loss Cap",
      meta: "Pauses automation if exceeded",
      value: data.maxDailyLossSats.toLocaleString(),
      unit: "sats",
    },
  ];

  return (
    <div className="wizard-screen fade-in">
      <div className="wizard-title">Review &amp; Launch</div>
      <div className="wizard-subtitle">
        Review the configuration before writing it to the node. All values are editable later under Settings.
      </div>

      <div className="policy-card" style={{ cursor: "default", marginBottom: 8 }}>
        <div>
          <div className="policy-card-label">Hub Pubkey</div>
          <div className="policy-card-meta">Reference — set via <code style={{ fontFamily: "var(--mono)" }}>TREASURY_PUBKEY</code> env var</div>
        </div>
        <div className="policy-card-value">
          {truncPubkey(data.detectedPubkey)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {policyCards.map((card) => (
          <div key={card.label} className="policy-card" style={{ cursor: "default" }}>
            <div>
              <div className="policy-card-label">{card.label}</div>
              <div className="policy-card-meta">{card.meta}</div>
            </div>
            <div className="policy-card-value">
              {card.value}
              <span className="unit">{card.unit}</span>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="alert critical" style={{ marginTop: 12 }}>
          <span className="alert-icon">✕</span>
          <div className="alert-body">
            <div className="alert-msg">{error}</div>
          </div>
        </div>
      )}

      <div className="wizard-footer" style={{ borderRadius: "0 0 12px 12px" }}>
        <button className="btn btn-ghost" onClick={onBack} disabled={saving}>← Back</button>
        <button
          className="btn btn-primary btn-lg"
          onClick={onConfirm}
          disabled={saving}
        >
          {saving ? "Saving…" : "Confirm & Launch ⚡"}
        </button>
      </div>
    </div>
  );
}

// ─── Row helper ───────────────────────────────────────────────────────────

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: "0.6875rem",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-3)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: mono ? "var(--mono)" : "var(--sans)",
          fontSize: "0.875rem",
          color: "var(--text)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Main Wizard ─────────────────────────────────────────────────────────

export default function Wizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [data, setData] = useState<WizardData>({
    detectedPubkey: "",
    feeRatePpm: 500,
    minOnchainReserveSats: 100000,
    maxDeployRatioPct: 80,
    maxDailyLossSats: 5000,
  });

  const patch = (v: Partial<WizardData>) => setData((d) => ({ ...d, ...v }));

  // On mount, if a prior policy exists (re-entry via Settings → Re-run
  // Setup Wizard), pre-populate inputs from it. On first install the
  // API may return zeros/defaults, in which case we fall back to the
  // hardcoded defaults above.
  useEffect(() => {
    Promise.all([
      api.getFeePolicy().catch(() => null),
      api.getCapitalPolicy().catch(() => null),
    ]).then(([fee, capital]) => {
      const patch_: Partial<WizardData> = {};
      if (fee && fee.fee_rate_ppm > 0) {
        patch_.feeRatePpm = fee.fee_rate_ppm;
      }
      if (capital) {
        const c = capital as unknown as Record<string, number>;
        if (c.min_onchain_reserve_sats > 0) {
          patch_.minOnchainReserveSats = c.min_onchain_reserve_sats;
        }
        if (c.max_deploy_ratio_ppm > 0) {
          patch_.maxDeployRatioPct = Math.round(c.max_deploy_ratio_ppm / 10000);
        }
        if (c.max_daily_loss_sats > 0) {
          patch_.maxDailyLossSats = c.max_daily_loss_sats;
        }
      }
      if (Object.keys(patch_).length > 0) {
        setData((d) => ({ ...d, ...patch_ }));
      }
    });
  }, []);

  const handleConfirm = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // 1. Set fee policy (base fee rate)
      await api.setFeePolicy(0, data.feeRatePpm);

      // 2. Set capital policy
      await api.setCapitalPolicy({
        min_onchain_reserve_sats: data.minOnchainReserveSats,
        max_deploy_ratio_ppm: Math.round(data.maxDeployRatioPct * 10000),
        max_daily_loss_sats: data.maxDailyLossSats,
      });

      // Mark setup complete and force a full reload so useAppStatus() re-runs
      localStorage.setItem("bitcorn_setup_done", "1");
      window.location.href = "/dashboard";
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Save failed. Check API logs.");
    } finally {
      setSaving(false);
    }
  };

  const screens = [
    <Screen1
      onNext={() => setStep(1)}
      onNodeDetected={(pk) => patch({ detectedPubkey: pk })}
    />,
    <Screen2 data={data} onChange={patch} onNext={() => setStep(2)} onBack={() => setStep(0)} />,
    <Screen3 data={data} onChange={patch} onNext={() => setStep(3)} onBack={() => setStep(1)} />,
    <Screen4
      data={data}
      onBack={() => setStep(2)}
      onConfirm={handleConfirm}
      saving={saving}
      error={saveError}
    />,
  ];

  return (
    <div className="wizard-bg">
      <div className="wizard-card">
        <div className="wizard-header">
          <div className="wizard-brand">
            <span style={{ fontSize: "1.25rem" }}>⚡</span>
            <span className="wizard-brand-mark">BITCORN LIGHTNING</span>
            <span className="topbar-tag">SETUP</span>
          </div>
          <StepLine current={step} total={4} />
        </div>

        <div className="wizard-body">{screens[step]}</div>
      </div>
    </div>
  );
}
