import { forwardRef } from "react";
import { HEALTH_COLOR, ROLE_COLOR, type LiquidityPeer } from "./types";
import { formatSatsShort } from "./transform";

type Props = {
  peer: LiquidityPeer;
  isSelected: boolean;
  pulseKey: number; // bump to replay the pulse animation
};

const LiquidityLaneRow = forwardRef<HTMLDivElement, Props>(({ peer, isSelected, pulseKey }, ref) => {
  const pct = peer.rolePct ?? 0;
  const pctInt = Math.round(pct * 100);
  const tierColor = HEALTH_COLOR[peer.healthTier];
  const roleColor = ROLE_COLOR[peer.role];

  return (
    <div
      ref={ref}
      className={`liq-lane-row${isSelected ? " is-selected" : ""}`}
      data-pubkey={peer.pubkey}
      data-pulse-key={pulseKey}
    >
      <span className="liq-lane-row-name" style={{ color: roleColor }}>
        {peer.name}
      </span>
      <span className="liq-lane-row-cap">{formatSatsShort(peer.capacity)}</span>
      <div className="liq-health-bar">
        <div
          className="liq-health-bar-fill"
          style={{
            width: `${pctInt}%`,
            background: tierColor,
          }}
        />
      </div>
      <span
        className="liq-health-chip"
        style={{
          color: tierColor,
          background: `color-mix(in srgb, ${tierColor} 20%, transparent)`,
        }}
      >
        {pctInt}%
      </span>
    </div>
  );
});

LiquidityLaneRow.displayName = "LiquidityLaneRow";

export default LiquidityLaneRow;
