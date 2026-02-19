import { useEffect, useState } from "react";
import {
  fetchRotationCandidates,
  executeRotation,
  RotationCandidate,
  RotationDryRunResult,
  truncPubkey,
  fmtSats,
} from "../api/client";

type DryRunState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: RotationDryRunResult }
  | { status: "error"; message: string };

const panelStyle: React.CSSProperties = {
  backgroundColor: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 20,
};

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  marginBottom: 16,
};

const headingStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: "#111827",
  margin: 0,
};

const badgeStyle: React.CSSProperties = {
  display: "inline-block",
  backgroundColor: "#fef3c7",
  color: "#92400e",
  border: "1px solid #fcd34d",
  borderRadius: 12,
  padding: "2px 10px",
  fontSize: 12,
  fontWeight: 600,
};

const rowStyle: React.CSSProperties = {
  borderTop: "1px solid #f3f4f6",
  padding: "12px 0",
};

const rowTopStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};

const rowMetaStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 20,
  marginTop: 6,
  flexWrap: "wrap",
};

const monoStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 13,
  color: "#374151",
};

const peerStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#6b7280",
  fontFamily: "monospace",
};

const previewButtonStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: 12,
  fontWeight: 500,
  color: "#374151",
  backgroundColor: "transparent",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const previewButtonDisabledStyle: React.CSSProperties = {
  ...previewButtonStyle,
  opacity: 0.55,
  cursor: "not-allowed",
};

const dryRunBoxStyle: React.CSSProperties = {
  marginTop: 10,
  padding: "10px 14px",
  backgroundColor: "#eff6ff",
  border: "1px solid #3b82f6",
  borderRadius: 6,
  fontSize: 13,
  color: "#1e40af",
  lineHeight: 1.6,
};

const errorBoxStyle: React.CSSProperties = {
  marginTop: 10,
  padding: "8px 14px",
  backgroundColor: "#fef2f2",
  border: "1px solid #fca5a5",
  borderRadius: 6,
  fontSize: 13,
  color: "#dc2626",
};

const metaLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#6b7280",
  marginRight: 2,
};

const metaValueStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#111827",
};

export default function RotationCandidatesPanel() {
  const [candidates, setCandidates] = useState<RotationCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [dryRunMap, setDryRunMap] = useState<Record<string, DryRunState>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    fetchRotationCandidates()
      .then((data) => {
        if (!cancelled) setCandidates(data);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setFetchError(err instanceof Error ? err.message : "Failed to load rotation candidates");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function getDryRunState(channelId: string): DryRunState {
    return dryRunMap[channelId] ?? { status: "idle" };
  }

  function setDryRunState(channelId: string, state: DryRunState) {
    setDryRunMap((prev) => ({ ...prev, [channelId]: state }));
  }

  async function handlePreviewClose(candidate: RotationCandidate) {
    const { channel_id } = candidate;
    setDryRunState(channel_id, { status: "loading" });
    try {
      const result = await executeRotation({ channel_id, dry_run: true });
      setDryRunState(channel_id, {
        status: "success",
        result: result as RotationDryRunResult,
      });
    } catch (err: unknown) {
      setDryRunState(channel_id, {
        status: "error",
        message: err instanceof Error ? err.message : "Dry run failed",
      });
    }
  }

  const isEmpty = !loading && !fetchError && candidates.length === 0;

  return (
    <div style={panelStyle}>
      <div style={headerRowStyle}>
        <h2 style={headingStyle}>Rotation Candidates</h2>
        {candidates.length > 0 && (
          <span style={badgeStyle}>{candidates.length} channels</span>
        )}
      </div>

      {loading && (
        <div style={{ color: "#6b7280", fontSize: 14 }}>Loading…</div>
      )}

      {fetchError && (
        <div style={errorBoxStyle}>{fetchError}</div>
      )}

      {isEmpty && (
        <div style={{ color: "#16a34a", fontSize: 14 }}>
          ✓ No rotation candidates
        </div>
      )}

      {!loading && !fetchError && candidates.length > 0 && (
        <div>
          {candidates.map((candidate) => {
            const dryRun = getDryRunState(candidate.channel_id);
            const isLoading = dryRun.status === "loading";

            return (
              <div key={candidate.channel_id} style={rowStyle}>
                <div style={rowTopStyle}>
                  <div>
                    <div style={monoStyle}>
                      {truncPubkey(candidate.channel_id)}
                      <span style={{ color: "#9ca3af", margin: "0 6px" }}>·</span>
                      <span style={peerStyle}>{truncPubkey(candidate.peer_pubkey)}</span>
                    </div>
                  </div>
                  <button
                    style={isLoading ? previewButtonDisabledStyle : previewButtonStyle}
                    disabled={isLoading}
                    onClick={() => handlePreviewClose(candidate)}
                  >
                    {isLoading ? "Checking…" : "Preview Close"}
                  </button>
                </div>

                <div style={rowMetaStyle}>
                  <span>
                    <span style={metaLabelStyle}>Score</span>
                    <span style={{ ...metaValueStyle, fontWeight: 700 }}>
                      {candidate.rotation_score}
                    </span>
                  </span>
                  <span>
                    <span style={metaLabelStyle}>Local</span>
                    <span style={metaValueStyle}>{fmtSats(candidate.local_sats)}</span>
                  </span>
                  <span>
                    <span style={metaLabelStyle}>ROI</span>
                    <span style={{ ...metaValueStyle, color: "#dc2626" }}>
                      {candidate.roi_ppm} ppm
                    </span>
                  </span>
                  <span style={{ fontStyle: "italic", color: "#6b7280", fontSize: 12 }}>
                    {candidate.reason}
                  </span>
                </div>

                {dryRun.status === "success" && (
                  <div style={dryRunBoxStyle}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Dry Run Result:</div>
                    <div>
                      Would close:{" "}
                      <span style={{ fontFamily: "monospace" }}>
                        {truncPubkey(dryRun.result.would_close.channel_id)}
                      </span>
                    </div>
                    <div>
                      Capacity: {fmtSats(dryRun.result.would_close.capacity_sats)}
                      {"  |  "}
                      Local: {fmtSats(dryRun.result.would_close.local_sats)}
                      {"  |  "}
                      ROI: {dryRun.result.would_close.roi_ppm} ppm
                    </div>
                    <div>Reason: {dryRun.result.would_close.reason}</div>
                  </div>
                )}

                {dryRun.status === "error" && (
                  <div style={errorBoxStyle}>{dryRun.message}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
