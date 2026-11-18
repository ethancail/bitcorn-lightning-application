// ConnectToHub's behaviour — the form state, validation, the open-channel call
// and the confirm-modal flow, moved as they are out of pages/MemberDashboard.tsx
// (member-first-run-ui separation slice, B.1). The move changed no behaviour.
// Since then handleOpen maps the API's `membership_not_paid` to its own message
// (membership-gating M1/M2 item 1), and it reads the treasury's verdict for
// the "Activate membership" button (B1). Slice 2 (2026-11-16): the capacity
// can be EMPTY (null) — clearing the box no longer forces 0 — and nothing is
// sent or confirmed without a capacity.
//
// fee-estimates (2026-11-18): the fee option is held by KEY (F3) and its rate
// is live (components/fees). What is sent is the rate the confirm summary
// showed — never a rate swapped in after it: if the card fetched that
// estimate over 10 min before confirm, it is refreshed, re-shown and confirmed
// again, and nothing is sent (O6, P18). No estimate, or an option above the
// 200 ceiling, blocks submit (O7, P15).

import { useEffect, useRef, useState } from "react";
import { api, type FeeEstimateOption, type FeeOptionKey, type TreasuryInfo } from "../../api/client";
import { RESHOWN, useActionConfirm } from "../actionConfirm/ActionConfirmModal";
import { summarizeOpenMemberChannel } from "../actionConfirm/confirmAction";
import {
  DEFAULT_FEE_OPTION,
  FEE_COPY,
  FEE_OPTION_LABEL,
  feeOptions,
  isAboveCeiling,
} from "../fees/feeEstimatesDescriptor";
import { isStaleAtConfirm, useFeeEstimates } from "../fees/useFeeEstimates";
import { classifyConfirmError } from "../actionConfirm/confirmErrors";
import {
  CONNECT_TO_HUB_COPY,
  HUB_PUBKEY,
  MIN_CAPACITY_OPEN_SATS,
  MIN_CAPACITY_WARNING_SATS,
  RENEW_MEMBERSHIP_TIERS,
} from "./connectToHubDescriptor";

export function useConnectToHub({ isPeered, initialCapacity }: { isPeered: boolean; initialCapacity?: number }) {
  const [capacity, setCapacity] = useState<number | null>(initialCapacity ?? 1_000_000);
  const [feeKey, setFeeKey] = useState<FeeOptionKey>(DEFAULT_FEE_OPTION);
  const fees = useFeeEstimates({ enabled: true });
  // The option the open summary showed, its rate, and when the card fetched it.
  const shownFee = useRef<{ key: FeeOptionKey; rate: number; fetchedAtMs: number | null } | null>(null);
  const [socket, setSocket] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treasuryInfo, setTreasuryInfo] = useState<TreasuryInfo | null>(null);
  const [treasuryInfoLoading, setTreasuryInfoLoading] = useState(true);

  useEffect(() => {
    api.getTreasuryInfo()
      .then(setTreasuryInfo)
      .catch(() => setTreasuryInfo(null))
      .finally(() => setTreasuryInfoLoading(false));
  }, []);

  // B1 (Ethan's ruling (a), 2026-11-06): the "Activate membership" button
  // shows only when the treasury's verdict is false. True, null, an absent
  // field (an older treasury) or a failed read all hide it. Read once per
  // mount, not polled: the status is a treasury-proxied call.
  // Its label (Ethan's ruling L1) comes from current_tier in the same response:
  // renew for a lapsed tier, activate for prepay and for anything else.
  const [membershipLocked, setMembershipLocked] = useState(false);
  const [membershipTier, setMembershipTier] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    api.getSubscriptionStatus()
      .then((st) => {
        if (cancelled) return;
        // Only a VERIFIED false locks (treasury-price-trust §4 R9); an
        // unverified one is unknown, and the treasury's acceptor decides.
        setMembershipLocked(st.open_channel_allowed === false && st.treasury_signature === "verified");
        setMembershipTier("current_tier" in st ? st.current_tier : undefined);
      })
      .catch(() => { if (!cancelled) setMembershipLocked(false); });
    return () => { cancelled = true; };
  }, []);
  const membershipLabel =
    membershipTier !== undefined && RENEW_MEMBERSHIP_TIERS.includes(membershipTier)
      ? CONNECT_TO_HUB_COPY.renewMembership
      : CONNECT_TO_HUB_COPY.activateMembership;

  const hubPubkey = treasuryInfo?.pubkey || HUB_PUBKEY;
  const hubSocket = treasuryInfo?.socket || null;
  const hasAutoSocket = !!hubSocket;

  // Human confirmation for the on-chain funding. apiFetch derives
  // x-bitcorn-confirm from the serialized body; nothing is hashed here.
  const confirm = useActionConfirm();

  const options = feeOptions(fees.estimates);
  const selected = options?.find((o) => o.key === feeKey) ?? null;
  /** Why submit is blocked by the fee, or null (O7: no estimate; P15: above the ceiling). */
  const feeBlocked: string | null =
    fees.status === "loading" ? null
    : !selected || !fees.estimates ? FEE_COPY.unavailable
    : isAboveCeiling(fees.estimates, selected) ? FEE_COPY.aboveCeiling(fees.estimates.ceiling_sat_per_vbyte)
    : null;

  function partnerSocketNow() {
    return (hasAutoSocket && !isPeered ? hubSocket : socket.trim() || undefined) || undefined;
  }

  function summaryFor(capacitySats: number, opt: Pick<FeeEstimateOption, "key" | "rate">) {
    return summarizeOpenMemberChannel({
      capacitySats,
      partnerSocket: partnerSocketNow(),
      // TreasuryInfo carries pubkey + socket only, no alias — the summary's
      // default label ("Bitcorn treasury hub") is the honest name here.
      hubLabel: undefined,
      fee: { label: FEE_OPTION_LABEL[opt.key], rate: opt.rate },
    });
  }

  function openChannelConfirm() {
    if (capacity == null || !selected || feeBlocked) return;
    shownFee.current = { key: selected.key, rate: selected.rate, fetchedAtMs: fees.fetchedAtMs };
    confirm.open(summaryFor(capacity, selected));
  }

  async function handleOpen() {
    const shown = shownFee.current;
    if (capacity == null || !shown) return;

    // O6 / P18: the shown estimate is over 10 min old (since the card fetched
    // it). Refresh, re-show, ask again; send nothing now.
    if (isStaleAtConfirm(shown.fetchedAtMs, Date.now())) {
      const next = await fees.refresh();
      const fresh = feeOptions(next.estimates)?.find((o) => o.key === shown.key);
      if (!fresh || isAboveCeiling(next.estimates!, fresh)) {
        // No figure to confirm now: close the modal; the card shows why.
        shownFee.current = null;
        confirm.dispatch({ t: "done" });
        return RESHOWN;
      }
      shownFee.current = { key: shown.key, rate: fresh.rate, fetchedAtMs: next.fetchedAtMs };
      confirm.dispatch({ t: "reshow", summary: summaryFor(capacity, fresh), notice: FEE_COPY.refreshed });
      return RESHOWN;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await api.openMemberChannel({
        capacity_sats: capacity,
        partner_socket: partnerSocketNow(),
        fee_rate: shown.rate,
      });
      setSuccess(res.funding_txid ?? "submitted");
    } catch (e: any) {
      // Confirmation failures go to the modal the operator is looking at.
      if (classifyConfirmError(e)) throw e;
      // The hub's membership gate (membership-gating M1/M2 item 1).
      if (e?.code === "membership_not_paid") {
        setError(CONNECT_TO_HUB_COPY.membershipNotPaid);
        return;
      }
      // LND refused the rate as below this node's relay floor (D6 ruling).
      if (e?.code === "fee_rate_below_network_minimum") {
        setError(FEE_COPY.tooLowForNetwork);
        return;
      }
      setError(e.message ?? CONNECT_TO_HUB_COPY.openFailed);
    } finally {
      setSubmitting(false);
    }
  }

  /** The capacity field's onChange: digits only; empty stays empty (null). */
  function setCapacityFromInput(value: string) {
    const raw = value.replace(/[^0-9]/g, "");
    setCapacity(raw === "" ? null : Number(raw));
  }

  return {
    capacity,
    setCapacity,
    setCapacityFromInput,
    feeKey,
    setFeeKey,
    fees,
    feeOptions: options,
    selectedFee: selected,
    feeBlocked,
    socket,
    setSocket,
    submitting,
    success,
    error,
    treasuryInfoLoading,
    hubPubkey,
    hasAutoSocket,
    confirm,
    openChannelConfirm,
    handleOpen,
    membershipLocked,
    membershipLabel,
    belowMinimum: capacity != null && capacity > 0 && capacity < MIN_CAPACITY_WARNING_SATS,
    openDisabled:
      submitting || capacity == null || capacity < MIN_CAPACITY_OPEN_SATS ||
      fees.status === "loading" || feeBlocked != null,
  };
}
