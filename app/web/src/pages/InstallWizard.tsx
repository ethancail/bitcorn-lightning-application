import { useEffect, useState } from "react";
import {
  fetchNode,
  setFeePolicy,
  setCapitalPolicy,
  NodeInfo,
} from "../api/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = { onComplete: () => void };

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const S = {
  page: {
    fontFamily: "system-ui, sans-serif",
    minHeight: "100vh",
    backgroundColor: "#f9fafb",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    paddingTop: 48,
    paddingBottom: 48,
  },
  card: {
    backgroundColor: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: 32,
    width: "100%",
    maxWidth: 560,
  },
  header: { marginBottom: 24 },
  title: { fontSize: 20, fontWeight: 700, margin: 0, color: "#111827" },
  stepIndicator: { fontSize: 13, color: "#6b7280", marginTop: 4 },
  label: {
    display: "block" as const,
    fontSize: 13,
    fontWeight: 600,
    color: "#374151",
    marginBottom: 4,
  },
  input: {
    width: "100%",
    boxSizing: "border-box" as const,
    padding: "8px 12px",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    fontSize: 14,
    outline: "none",
  },
  helper: { fontSize: 12, color: "#6b7280", marginTop: 4 },
  btnRow: { display: "flex", justifyContent: "space-between", marginTop: 32 },
  btnBack: {
    padding: "9px 20px",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    background: "#fff",
    cursor: "pointer",
    fontSize: 14,
    color: "#374151",
  },
  btnNext: {
    padding: "9px 24px",
    border: "none",
    borderRadius: 6,
    background: "#f7931a",
    color: "#fff",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
  },
  btnDisabled: { opacity: 0.4, cursor: "not-allowed" },
  errorBox: {
    padding: "10px 14px",
    border: "1px solid #fca5a5",
    borderRadius: 6,
    backgroundColor: "#fef2f2",
    color: "#dc2626",
    fontSize: 13,
    marginTop: 12,
  },
  warnBox: {
    padding: "10px 14px",
    border: "1px solid #fcd34d",
    borderRadius: 6,
    backgroundColor: "#fffbeb",
    color: "#92400e",
    fontSize: 13,
    marginTop: 12,
    marginBottom: 12,
  },
  field: { marginBottom: 20 },
  mono: { fontFamily: "monospace", fontSize: 12 },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "8px 0",
    borderBottom: "1px solid #f3f4f6",
    fontSize: 14,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncPubkey(pk: string): string {
  if (!pk || pk.length < 20) return pk;
  return `${pk.slice(0, 12)}\u2026${pk.slice(-6)}`;
}

function isPositiveInt(val: string, min = 1, max = Number.MAX_SAFE_INTEGER): boolean {
  const n = Number(val);
  return (
    val.trim() !== "" &&
    Number.isFinite(n) &&
    Number.isInteger(n) &&
    n >= min &&
    n <= max
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function WizardHeader({ step }: { step: number }) {
  return (
    <div style={S.header}>
      <p style={S.title}>Bitcorn Lightning &mdash; Setup</p>
      <p style={S.stepIndicator}>Step {step} of 5</p>
    </div>
  );
}

interface BtnRowProps {
  onBack: () => void;
  onNext: () => void;
  backDisabled?: boolean;
  nextDisabled?: boolean;
  nextLabel?: string;
}

function BtnRow({
  onBack,
  onNext,
  backDisabled,
  nextDisabled,
  nextLabel = "Next",
}: BtnRowProps) {
  return (
    <div style={S.btnRow}>
      <button
        style={backDisabled ? { ...S.btnBack, ...S.btnDisabled } : S.btnBack}
        disabled={backDisabled}
        onClick={onBack}
      >
        Back
      </button>
      <button
        style={nextDisabled ? { ...S.btnNext, ...S.btnDisabled } : S.btnNext}
        disabled={nextDisabled}
        onClick={onNext}
      >
        {nextLabel}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function InstallWizard({ onComplete }: Props) {
  // Navigation
  const [step, setStep] = useState<number>(1);

  // Screen 1
  const [node, setNode] = useState<NodeInfo | null>(null);
  const [nodeLoading, setNodeLoading] = useState<boolean>(false);
  const [nodeError, setNodeError] = useState<string | null>(null);

  // Screen 2
  const [confirmedPubkey, setConfirmedPubkey] = useState<string>("");

  // Screen 3
  const [feeRatePpm, setFeeRatePpm] = useState<string>("500");

  // Screen 4
  const [reserveSats, setReserveSats] = useState<string>("100000");
  const [maxDeployPct, setMaxDeployPct] = useState<string>("80");
  const [dailyLossCap, setDailyLossCap] = useState<string>("5000");

  // Async states
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ---- Screen 1: fetch node on mount ----
  useEffect(() => {
    if (step !== 1) return;
    setNodeLoading(true);
    setNodeError(null);
    fetchNode()
      .then((n) => {
        setNode(n);
      })
      .catch((err: unknown) => {
        setNodeError(
          err instanceof Error ? err.message : "Failed to connect to LND node."
        );
      })
      .finally(() => {
        setNodeLoading(false);
      });
  }, [step]);

  // ---- Clear submit error when changing step ----
  useEffect(() => {
    setSubmitError(null);
    setSubmitting(false);
  }, [step]);

  // ---- Navigation handlers ----

  function goBack() {
    if (step > 1) setStep((s) => s - 1);
  }

  // Step 1 -> 2
  function handleStep1Next() {
    if (!node) return;
    setConfirmedPubkey(node.pubkey);
    setStep(2);
  }

  // Step 2 -> 3
  function handleStep2Next() {
    setStep(3);
  }

  // Step 3 -> 4
  async function handleStep3Next() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await setFeePolicy(Number(feeRatePpm));
      setStep(4);
    } catch (err: unknown) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to save fee policy."
      );
    } finally {
      setSubmitting(false);
    }
  }

  // Step 4 -> 5
  async function handleStep4Next() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await setCapitalPolicy({
        min_onchain_reserve_sats: Number(reserveSats),
        max_deploy_ratio_ppm: Number(maxDeployPct) * 10000,
        max_daily_loss_sats: Number(dailyLossCap),
      });
      setStep(5);
    } catch (err: unknown) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to save capital policy."
      );
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Derived validation ----

  const step1NextDisabled =
    nodeLoading || node === null || node.synced_to_chain !== 1;

  const step3NextDisabled =
    submitting || !isPositiveInt(feeRatePpm, 1, 10000);

  const step4NextDisabled =
    submitting ||
    !isPositiveInt(reserveSats, 0) ||
    !isPositiveInt(maxDeployPct, 1, 100) ||
    !isPositiveInt(dailyLossCap, 0);

  // ---- Screen renderers ----

  function renderStep1() {
    return (
      <>
        <WizardHeader step={1} />

        <h2
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: "#111827",
            marginBottom: 16,
            marginTop: 0,
          }}
        >
          LND Connection
        </h2>

        {nodeLoading && (
          <p style={{ color: "#6b7280", fontSize: 14 }}>
            Connecting to LND node&hellip;
          </p>
        )}

        {nodeError && <div style={S.errorBox}>{nodeError}</div>}

        {!nodeLoading && node && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={S.field}>
              <span style={S.label}>Node alias</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>
                {node.alias || "(no alias)"}
              </span>
            </div>

            <div style={S.field}>
              <span style={S.label}>Pubkey</span>
              <span style={{ ...S.mono, color: "#374151" }}>
                {truncPubkey(node.pubkey)}
              </span>
            </div>

            <div style={S.field}>
              <span style={S.label}>Block height</span>
              <span style={{ fontSize: 14, color: "#374151" }}>
                {node.block_height !== null
                  ? node.block_height.toLocaleString()
                  : "Unknown"}
              </span>
            </div>

            <div style={S.field}>
              <span style={S.label}>Chain sync</span>
              {node.synced_to_chain === 1 ? (
                <span
                  style={{ fontSize: 14, fontWeight: 600, color: "#16a34a" }}
                >
                  Synced
                </span>
              ) : (
                <span
                  style={{ fontSize: 14, fontWeight: 600, color: "#dc2626" }}
                >
                  Not synced
                </span>
              )}
            </div>
          </div>
        )}

        <BtnRow
          onBack={goBack}
          onNext={handleStep1Next}
          backDisabled={true}
          nextDisabled={step1NextDisabled}
        />
      </>
    );
  }

  function renderStep2() {
    return (
      <>
        <WizardHeader step={2} />

        <h2
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: "#111827",
            marginBottom: 16,
            marginTop: 0,
          }}
        >
          Treasury Identity
        </h2>

        <div style={S.field}>
          <span style={S.label}>Detected node pubkey</span>
          <div
            style={{
              ...S.mono,
              padding: "8px 12px",
              backgroundColor: "#f9fafb",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              color: "#374151",
              wordBreak: "break-all",
            }}
          >
            {node?.pubkey ?? "(unavailable)"}
          </div>
        </div>

        <div style={S.field}>
          <label style={S.label} htmlFor="treasury-pubkey">
            TREASURY_PUBKEY
          </label>
          <input
            id="treasury-pubkey"
            style={S.input}
            type="text"
            value={confirmedPubkey}
            onChange={(e) => setConfirmedPubkey(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div style={S.warnBox}>
          This value must be set as the <strong>TREASURY_PUBKEY</strong>{" "}
          environment variable in your <code>docker-compose.yml</code>. Changing
          it here does not take effect until you restart the container.
        </div>

        <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>
          This identifies the hub node. All treasury endpoints require this to
          be set correctly.
        </p>

        <BtnRow
          onBack={goBack}
          onNext={handleStep2Next}
          nextDisabled={confirmedPubkey.trim().length === 0}
        />
      </>
    );
  }

  function renderStep3() {
    return (
      <>
        <WizardHeader step={3} />

        <h2
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: "#111827",
            marginBottom: 16,
            marginTop: 0,
          }}
        >
          Base Fee Rate
        </h2>

        <div style={S.field}>
          <label style={S.label} htmlFor="fee-rate-ppm">
            Base fee rate (ppm)
          </label>
          <input
            id="fee-rate-ppm"
            style={S.input}
            type="number"
            min={1}
            max={10000}
            value={feeRatePpm}
            onChange={(e) => setFeeRatePpm(e.target.value)}
          />
          <p style={S.helper}>
            The dynamic fee engine scales this 0.25&times;&ndash;4.0&times; per
            channel based on liquidity health. 500 ppm is a safe starting point.
          </p>
        </div>

        {submitError && <div style={S.errorBox}>{submitError}</div>}

        <BtnRow
          onBack={goBack}
          onNext={handleStep3Next}
          nextDisabled={step3NextDisabled}
          nextLabel={submitting ? "Saving\u2026" : "Next"}
        />
      </>
    );
  }

  function renderStep4() {
    return (
      <>
        <WizardHeader step={4} />

        <h2
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: "#111827",
            marginBottom: 16,
            marginTop: 0,
          }}
        >
          Capital Policy
        </h2>

        <div style={S.field}>
          <label style={S.label} htmlFor="reserve-sats">
            Min on-chain reserve (sats)
          </label>
          <input
            id="reserve-sats"
            style={S.input}
            type="number"
            min={0}
            value={reserveSats}
            onChange={(e) => setReserveSats(e.target.value)}
          />
          <p style={S.helper}>
            Minimum sats kept on-chain. Channel opens are blocked if balance
            falls below this.
          </p>
        </div>

        <div style={S.field}>
          <label style={S.label} htmlFor="max-deploy-pct">
            Max deploy ratio (%)
          </label>
          <input
            id="max-deploy-pct"
            style={S.input}
            type="number"
            min={1}
            max={100}
            value={maxDeployPct}
            onChange={(e) => setMaxDeployPct(e.target.value)}
          />
          <p style={S.helper}>
            Maximum percentage of on-chain funds that can be deployed as channel
            capacity.
          </p>
        </div>

        <div style={S.field}>
          <label style={S.label} htmlFor="daily-loss-cap">
            Max daily loss cap (sats)
          </label>
          <input
            id="daily-loss-cap"
            style={S.input}
            type="number"
            min={0}
            value={dailyLossCap}
            onChange={(e) => setDailyLossCap(e.target.value)}
          />
          <p style={S.helper}>
            Automated rebalancing stops if fee spend exceeds this in a 24-hour
            window.
          </p>
        </div>

        {submitError && <div style={S.errorBox}>{submitError}</div>}

        <BtnRow
          onBack={goBack}
          onNext={handleStep4Next}
          nextDisabled={step4NextDisabled}
          nextLabel={submitting ? "Saving\u2026" : "Next"}
        />
      </>
    );
  }

  function renderStep5() {
    const deployPct = isPositiveInt(maxDeployPct, 1, 100)
      ? Number(maxDeployPct)
      : 0;
    const reserveNum = isPositiveInt(reserveSats, 0) ? Number(reserveSats) : 0;
    const feeNum = isPositiveInt(feeRatePpm, 1, 10000) ? Number(feeRatePpm) : 0;
    const lossNum = isPositiveInt(dailyLossCap, 0) ? Number(dailyLossCap) : 0;

    return (
      <>
        <WizardHeader step={5} />

        <h2
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: "#111827",
            marginBottom: 16,
            marginTop: 0,
          }}
        >
          Confirmation
        </h2>

        <p
          style={{
            fontSize: 13,
            color: "#6b7280",
            marginBottom: 20,
            marginTop: 0,
          }}
        >
          Review your settings before launching. You can adjust any of these
          values later from the dashboard.
        </p>

        <div>
          <div style={S.summaryRow}>
            <span style={{ color: "#6b7280" }}>Node alias</span>
            <span style={{ fontWeight: 600 }}>{node?.alias || "(no alias)"}</span>
          </div>
          <div style={S.summaryRow}>
            <span style={{ color: "#6b7280" }}>Node pubkey</span>
            <span style={S.mono}>{truncPubkey(node?.pubkey ?? "")}</span>
          </div>
          <div style={S.summaryRow}>
            <span style={{ color: "#6b7280" }}>TREASURY_PUBKEY</span>
            <span style={S.mono}>{truncPubkey(confirmedPubkey)}</span>
          </div>
          <div style={S.summaryRow}>
            <span style={{ color: "#6b7280" }}>Base fee rate</span>
            <span>{feeNum.toLocaleString()} ppm</span>
          </div>
          <div style={S.summaryRow}>
            <span style={{ color: "#6b7280" }}>Min on-chain reserve</span>
            <span>{reserveNum.toLocaleString()} sats</span>
          </div>
          <div style={S.summaryRow}>
            <span style={{ color: "#6b7280" }}>Max deploy ratio</span>
            <span>{deployPct}%</span>
          </div>
          <div style={{ ...S.summaryRow, borderBottom: "none" }}>
            <span style={{ color: "#6b7280" }}>Max daily loss cap</span>
            <span>{lossNum.toLocaleString()} sats</span>
          </div>
        </div>

        <div style={{ marginTop: 32 }}>
          <button
            style={{
              ...S.btnNext,
              width: "100%",
              padding: "12px 24px",
              fontSize: 15,
            }}
            onClick={onComplete}
          >
            Confirm &amp; Launch
          </button>
        </div>

        <div style={{ ...S.btnRow, justifyContent: "flex-start" }}>
          <button style={S.btnBack} onClick={goBack}>
            Back
          </button>
        </div>
      </>
    );
  }

  // ---- Root render ----

  return (
    <div style={S.page}>
      <div style={S.card}>
        {step === 1 && renderStep1()}
        {step === 2 && renderStep2()}
        {step === 3 && renderStep3()}
        {step === 4 && renderStep4()}
        {step === 5 && renderStep5()}
      </div>
    </div>
  );
}
