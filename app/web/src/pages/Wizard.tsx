import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api, type NodeInfo } from "../api/client";

type WizardData = {
  detectedPubkey: string;
  treasuryPubkey: string;
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
  const labels = ["Node", "Identity", "Base Fee", "Policy", "Confirm"];
  return (
    <div>
      <div className="wizard-step-line">
        {Array.from({ length: total }).map((_, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", flex: i < total - 1 ? 1 : 0 }}>
            <div
              className={`wizard-step-dot ${i < current ? "done" : i === current ? "active" : ""}`}
            />
            {i < total - 1 && <div className="wizard-step-connector" />}
          </div>
        ))}
      </div>
      <div className="wizard-step-label">{`Step ${current + 1} of ${total} — ${labels[current]}`}</div>
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
        <div className="alert critical">
          <span className="alert-icon">✕</span>
          <div className="alert-body">
            <div className="alert-msg">{error}</div>
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

      <div className="wizard-footer" style={{ borderRadius: "0 0 12px 12px" }}>
        <span />
        <button
          className="btn btn-primary"
          disabled={!node || !synced}
          onClick={onNext}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

// ─── Screen 2: Treasury Identity ─────────────────────────────────────────

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
  return (
    <div className="wizard-screen fade-in">
      <div className="wizard-title">Treasury Identity</div>
      <div className="wizard-subtitle">Set the pubkey that identifies this hub node.</div>

      <div className="form-group">
        <label className="form-label">Detected Node Pubkey</label>
        <input
          className="form-input"
          readOnly
          value={data.detectedPubkey}
        />
        <span className="form-helper">Auto-detected from your LND node.</span>
      </div>

      <div
        style={{
          background: "var(--bg-2)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "14px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div className="form-label">Treasury Hub Pubkey</div>
        <div
          className="mono"
          style={{ color: "var(--amber)", fontSize: "0.8125rem", wordBreak: "break-all" }}
        >
          {data.detectedPubkey || "—"}
        </div>
        <div className="form-helper">
          This is your node's pubkey. Set <code style={{ color: "var(--amber)", fontFamily: "var(--mono)" }}>TREASURY_PUBKEY</code> to
          this value in your Umbrel app environment settings. Once set, all treasury
          endpoints will be gated to this node.
        </div>
      </div>

      <div className="alert info" style={{ marginTop: 4 }}>
        <span className="alert-icon">ℹ</span>
        <div className="alert-body">
          <div className="alert-msg">
            <code style={{ fontFamily: "var(--mono)" }}>TREASURY_PUBKEY</code> is an environment variable managed by Umbrel — it cannot be
            changed from the UI. Configure it in the Umbrel app settings before proceeding.
          </div>
        </div>
      </div>

      <div className="wizard-footer" style={{ borderRadius: "0 0 12px 12px" }}>
        <button className="btn btn-ghost" onClick={onBack}>← Back</button>
        <button className="btn btn-primary" onClick={onNext}>
          Next →
        </button>
      </div>
    </div>
  );
}

// ─── Screen 3: Base Fee Rate ──────────────────────────────────────────────

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

// ─── Screen 4: Capital Policy ─────────────────────────────────────────────

function Screen4({
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

// ─── Screen 5: Confirmation ───────────────────────────────────────────────

function Screen5({
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
  const rows: Array<{ label: string; value: string }> = [
    { label: "Hub Pubkey (reference)", value: truncPubkey(data.detectedPubkey) },
    { label: "Base Fee Rate", value: `${data.feeRatePpm} ppm` },
    { label: "Min On-Chain Reserve", value: `${data.minOnchainReserveSats.toLocaleString()} sats` },
    { label: "Max Deploy Ratio", value: `${data.maxDeployRatioPct}%` },
    { label: "Max Daily Loss Cap", value: `${data.maxDailyLossSats.toLocaleString()} sats` },
  ];

  return (
    <div className="wizard-screen fade-in">
      <div className="wizard-title">Confirm & Launch</div>
      <div className="wizard-subtitle">Review the configuration before writing it to the node.</div>

      <div
        style={{
          background: "var(--bg-2)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        {rows.map((row, i) => (
          <div
            key={row.label}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "11px 16px",
              borderBottom: i < rows.length - 1 ? "1px solid var(--border)" : "none",
            }}
          >
            <span className="form-label" style={{ marginBottom: 0 }}>{row.label}</span>
            <span
              className="mono"
              style={{ color: "var(--amber)", fontSize: "0.875rem" }}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>

      {error && (
        <div className="alert critical">
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
    treasuryPubkey: "",
    feeRatePpm: 500,
    minOnchainReserveSats: 100000,
    maxDeployRatioPct: 80,
    maxDailyLossSats: 5000,
  });

  const patch = (v: Partial<WizardData>) => setData((d) => ({ ...d, ...v }));

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

      // Mark setup complete
      localStorage.setItem("bitcorn_setup_done", "1");
      navigate("/dashboard");
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Save failed. Check API logs.");
    } finally {
      setSaving(false);
    }
  };

  const screens = [
    <Screen1
      onNext={() => setStep(1)}
      onNodeDetected={(pk) => patch({ detectedPubkey: pk, treasuryPubkey: pk })}
    />,
    <Screen2 data={data} onChange={patch} onNext={() => setStep(2)} onBack={() => setStep(0)} />,
    <Screen3 data={data} onChange={patch} onNext={() => setStep(3)} onBack={() => setStep(1)} />,
    <Screen4 data={data} onChange={patch} onNext={() => setStep(4)} onBack={() => setStep(2)} />,
    <Screen5
      data={data}
      onBack={() => setStep(3)}
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
          <StepLine current={step} total={5} />
        </div>

        <div className="wizard-body">{screens[step]}</div>
      </div>
    </div>
  );
}
