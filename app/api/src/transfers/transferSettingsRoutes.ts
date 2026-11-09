// GET / PATCH /api/transfers/settings (drive-mode P3). The body is the stored
// and effective settings (transferSettings.ts) plus the member's own minimum
// connection sizes (memberMinimums.ts), so the page states every figure from
// the server in one read.
//
// PATCH is EXEMPT from action-confirmation (R40(4); the 2026-09-03 decision:
// routes that govern what an outflow may do are exempt), and in P3 nothing
// reads these values to move money.

import type http from "http";
import { memberMinimumConnections } from "./memberMinimums";
import { saveTransferSettings, transferSettingsResponse, validateTransferSettingsPatch } from "./transferSettings";

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function fullResponse() {
  return { ...transferSettingsResponse(), member: await memberMinimumConnections() };
}

export async function handleTransferSettingsGet(res: http.ServerResponse): Promise<void> {
  try {
    send(res, 200, await fullResponse());
  } catch (err: any) {
    send(res, 500, { error: err?.message });
  }
}

/** Resolves once the response is written. */
export function handleTransferSettingsPatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          send(res, 400, { error: "invalid_json" });
          return resolve();
        }
        const v = validateTransferSettingsPatch(parsed);
        if (!v.ok) {
          send(res, 400, { error: "invalid_transfer_settings", details: v.errors });
          return resolve();
        }
        saveTransferSettings(v.patch);
        send(res, 200, await fullResponse());
      } catch (err: any) {
        send(res, 500, { error: err?.message });
      }
      resolve();
    });
  });
}
