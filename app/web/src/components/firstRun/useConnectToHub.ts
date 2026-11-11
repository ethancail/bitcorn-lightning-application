// ConnectToHub's behaviour — the form state, validation, the open-channel call
// and the confirm-modal flow, moved as they are out of pages/MemberDashboard.tsx
// (member-first-run-ui separation slice, B.1). The move changed no behaviour.
// Since then handleOpen maps the API's `membership_not_paid` to its own message
// (membership-gating M1/M2 item 1), and it reads the treasury's verdict for
// the "Activate membership" button (B1); everything else is as moved.

import { useEffect, useState } from "react";
import { api, type TreasuryInfo } from "../../api/client";
import { useActionConfirm } from "../actionConfirm/ActionConfirmModal";
import { summarizeOpenMemberChannel } from "../actionConfirm/confirmAction";
import { classifyConfirmError } from "../actionConfirm/confirmErrors";
import {
  CONNECT_TO_HUB_COPY,
  HUB_PUBKEY,
  MIN_CAPACITY_OPEN_SATS,
  MIN_CAPACITY_WARNING_SATS,
  RENEW_MEMBERSHIP_TIERS,
} from "./connectToHubDescriptor";

export function useConnectToHub({ isPeered, initialCapacity }: { isPeered: boolean; initialCapacity?: number }) {
  const [capacity, setCapacity] = useState(initialCapacity ?? 1_000_000);
  const [feeRate, setFeeRate] = useState<number | undefined>(undefined);
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

  function openChannelConfirm() {
    const partnerSocket = hasAutoSocket && !isPeered ? hubSocket : socket.trim() || undefined;
    confirm.open(
      summarizeOpenMemberChannel({
        capacitySats: capacity,
        partnerSocket: partnerSocket || undefined,
        // TreasuryInfo carries pubkey + socket only, no alias — the summary's
        // default label ("Bitcorn treasury hub") is the honest name here.
        hubLabel: undefined,
      }),
    );
  }

  async function handleOpen() {
    setSubmitting(true);
    setError(null);
    try {
      const partnerSocket = hasAutoSocket && !isPeered ? hubSocket : socket.trim() || undefined;
      const res = await api.openMemberChannel({
        capacity_sats: capacity,
        partner_socket: partnerSocket || undefined,
        ...(feeRate ? { fee_rate: feeRate } : {}),
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
      setError(e.message ?? CONNECT_TO_HUB_COPY.openFailed);
    } finally {
      setSubmitting(false);
    }
  }

  /** The capacity field's onChange, as it was: digits only, empty → 0. */
  function setCapacityFromInput(value: string) {
    const raw = value.replace(/[^0-9]/g, "");
    if (raw === "") { setCapacity(0); return; }
    setCapacity(Number(raw));
  }

  return {
    capacity,
    setCapacity,
    setCapacityFromInput,
    feeRate,
    setFeeRate,
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
    belowMinimum: capacity > 0 && capacity < MIN_CAPACITY_WARNING_SATS,
    openDisabled: submitting || capacity < MIN_CAPACITY_OPEN_SATS,
  };
}
