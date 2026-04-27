import { forwardRef, useEffect, useState } from "react";
import { HEALTH_COLOR, ROLE_COLOR, type LiquidityPeer } from "./types";
import { formatSatsShort } from "./transform";

type Props = {
  peer: LiquidityPeer;
  isSelected: boolean;
  pulseKey: number;
};

const LiquidityLaneRow = forwardRef<HTMLDivElement, Props>(({ peer, isSelected, pulseKey }, ref) => {
  const pct = peer.rolePct ?? 0;
  const pctInt = Math.round(pct * 100);
  const tierColor = HEALTH_COLOR[peer.healthTier];
  const roleColor = ROLE_COLOR[peer.role];
  const [pulseClass, setPulseClass] = useState("");

  // Trigger the pulse animation when this row becomes selected (or pulseKey bumps while selected).
  useEffect(() => {
    if (!isSelected) {
      setPulseClass("");
      return;
    }
    setPulseClass(""); // reset so re-applying re-triggers the keyframes
    const t = setTimeout(() => setPulseClass("is-pulsing"), 0);
    return () => clearTimeout(t);
  }, [isSelected, pulseKey]);

  return (
    <div
      ref={ref}
      className={`liq-lane-row${isSelected ? " is-selected" : ""}${pulseClass ? " " + pulseClass : ""}`}
      data-pubkey={peer.pubkey}
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
