import { useMemo, useRef } from "react";
import LiquidityLaneRow from "./LiquidityLaneRow";
import { comparePeers } from "./transform";
import { useFlip } from "./useFlip";
import type { LiquidityPeer } from "./types";

type Props = {
  title: string;
  peers: LiquidityPeer[];
  selectedPubkey: string | null;
  pulseKey: number;
  rowRefs: Map<string, HTMLDivElement | null>;
};

export default function LiquidityLane({ title, peers, selectedPubkey, pulseKey, rowRefs }: Props) {
  const sorted = useMemo(() => [...peers].sort(comparePeers), [peers]);
  const localRefs = useRef<Map<string, HTMLElement | null>>(new Map());

  // FLIP animation when urgency order changes (e.g. on refresh).
  useFlip(sorted.map((p) => p.pubkey), localRefs.current);

  return (
    <div className="liq-lane panel ops fade-in">
      <div className="panel-header">
        <span className="panel-title">{title}</span>
        <span className="badge badge-muted">{sorted.length}</span>
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        {sorted.length === 0 ? (
          <div className="empty-state" style={{ padding: 16 }}>No peers in this role.</div>
        ) : (
          sorted.map((peer) => (
            <LiquidityLaneRow
              key={peer.pubkey}
              peer={peer}
              isSelected={peer.pubkey === selectedPubkey}
              pulseKey={pulseKey}
              ref={(el) => {
                rowRefs.set(peer.pubkey, el);
                localRefs.current.set(peer.pubkey, el);
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}
