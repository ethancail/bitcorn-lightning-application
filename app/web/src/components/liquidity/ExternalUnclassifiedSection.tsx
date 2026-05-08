import { useState } from "react";
import { ROLE_COLOR, type LiquidityPeer } from "./types";
import { formatSatsShort } from "./transform";

type Props = { peers: LiquidityPeer[] };

export default function ExternalUnclassifiedSection({ peers }: Props) {
  const [open, setOpen] = useState(false);
  if (peers.length === 0) return null;

  return (
    <div className="liq-external-section panel fade-in">
      <button
        type="button"
        className="liq-external-header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="liq-external-chevron">{open ? "▾" : "▸"}</span>
        <span className="liq-external-title">External &amp; Unclassified</span>
        <span className="badge badge-muted">{peers.length}</span>
      </button>
      {open && (
        <div className="panel-body">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th style={{ textAlign: "right" }}>Capacity</th>
                <th style={{ textAlign: "right" }}>Treasury Local</th>
                <th style={{ textAlign: "right" }}>Treasury Remote</th>
                <th style={{ textAlign: "right" }}>Util %</th>
              </tr>
            </thead>
            <tbody>
              {peers.map((peer) => {
                const util = peer.capacity > 0 ? Math.round((peer.memberRemote / peer.capacity) * 100) : 0;
                return (
                  <tr key={peer.pubkey}>
                    <td style={{ color: ROLE_COLOR[peer.role], fontWeight: 600 }}>{peer.name}</td>
                    <td style={{ color: "var(--text-3)", textTransform: "capitalize" }}>{peer.role}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>{formatSatsShort(peer.capacity)}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-3)" }}>{formatSatsShort(peer.memberRemote)}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-3)" }}>{formatSatsShort(peer.memberLocal)}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>{util}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
