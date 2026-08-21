// The ONE I/O edge for cert-expiry inspection: read the file, hand the bytes to
// the pure inspector.
//
// ./certExpiry.ts stays pure (no fs, no clock) so its tests need no mocking and
// no scratch directory. This module is the thin impure shell around it, kept
// separate for exactly that reason and deliberately tiny.
//
// NEVER THROWS. A missing file, a permissions error and unparseable bytes all
// become `{ok:false, reason}`. Both callers — the treasury alert producer and
// the member-side scheduler — run on polls where a throw would either kill a
// tick or force a try/catch at every call site, and "we could not read the
// cert" is a reportable state rather than an error to swallow.
//
// ⚠ NO LND CALL HAPPENS HERE. That is the property the whole arc rests on: the
// cert is readable from local disk while every gRPC call is failing, which is
// what lets a lapsed cert be distinguished from a transient blip when the
// classifier necessarily reports both as `connectivity`.

import fs from "fs";
import { TLS_CERT_PATH } from "./lndPaths";
import { inspectCertBytes, type CertInspection } from "./certExpiry";

/**
 * Read LND's tls.cert and report its validity window relative to `nowMs`.
 *
 * `nowMs` is injected by the caller, matching ./certExpiry.ts and
 * ../base/staleness.ts — this module reads the filesystem, never the clock.
 */
export function readLocalCertExpiry(nowMs: number): CertInspection {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(TLS_CERT_PATH);
  } catch (err) {
    return {
      ok: false,
      reason: `could not read ${TLS_CERT_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return inspectCertBytes(bytes, nowMs);
}
