// ConnectToHub's behaviour — the form state, validation, the open-channel call
// and the confirm-modal flow, moved as they are out of pages/MemberDashboard.tsx
// (member-first-run-ui separation slice, B.1). No behaviour changes here: the
// handlers are today's, line for line.

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
    belowMinimum: capacity > 0 && capacity < MIN_CAPACITY_WARNING_SATS,
    openDisabled: submitting || capacity < MIN_CAPACITY_OPEN_SATS,
  };
}
