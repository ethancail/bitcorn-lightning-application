import { createHash, createHmac } from "crypto";
import type { ManualMetricKey } from "./manualInputStore";

export interface SubmissionBody {
  submitted_at: string; // ISO
  values: Record<ManualMetricKey, number>;
}

export interface WorkerPostResult {
  ok: boolean;
  status: number;
  error?: string;
}

function canonicalString(timestamp: string, body: string): string {
  return `${timestamp}\n${createHash("sha256").update(body).digest("hex")}`;
}

function signHmac(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(canonicalString(timestamp, body)).digest("hex");
}

/**
 * Post a manual-input submission to the Worker. Never throws — returns a
 * structured result so the caller can persist a sync-status update.
 */
export async function postManualInputToWorker(
  workerBaseUrl: string,
  hmacSecret: string,
  submission: SubmissionBody,
): Promise<WorkerPostResult> {
  const body = JSON.stringify(submission);
  const timestamp = submission.submitted_at; // same ISO used as the signed timestamp
  const signature = signHmac(hmacSecret, timestamp, body);

  try {
    const res = await fetch(`${workerBaseUrl}/valuation/manual`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Valuation-Timestamp": timestamp,
        "X-Valuation-Signature": signature,
      },
      body,
    });
    if (res.status === 204) {
      return { ok: true, status: 204 };
    }
    const errBody = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: errBody.slice(0, 500) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
