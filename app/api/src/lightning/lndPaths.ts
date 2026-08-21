// Where LND's credential files live. ONE definition, shared.
//
// WHY THIS IS ITS OWN MODULE, AND WHY IT IMPORTS ALMOST NOTHING.
//
// Two places now need the tls.cert path: the client that authenticates with it
// (./lnd.ts) and the expiry inspector that reads its notAfter
// (./readCertExpiry.ts). Re-deriving `path.join(...)` in the second would be a
// silent drift risk the day LND_DIR or the filename changes — and an expiry
// check is only meaningful if it inspects the very bytes the client uses.
//
// Importing the constant from ./lnd.ts instead would have been worse in a way
// that is easy to miss: api/treasury-alerts.test.ts:81 already does
// `vi.mock("../lightning/lnd", ...)`, and that mock does not export
// TLS_CERT_PATH. Any consumer reached from that test would have silently
// received `undefined` and then read a nonsense path — a test passing for the
// wrong reason rather than failing.
//
// So this module deliberately imports ONLY `path`. No ENV, no ln-service, no
// db. Nothing mocks it, nothing heavy loads because of it, and it cannot throw
// at import time. MACAROON_PATH deliberately stays in ./lnd.ts: it needs
// ENV.bitcoinNetwork, and `path.join(..., undefined, ...)` throws a TypeError,
// so pulling ENV in here would make a mocked-env test crash at module load.

import path from "path";

/** Root of the LND data directory as mounted into this container. */
export const LND_DIR = process.env.LND_DIR ?? "/lnd";

/**
 * LND's self-signed TLS certificate.
 *
 * On Umbrel this is a LIVE BIND MOUNT (bitcorn-lightning-node/docker-compose.yml:9
 * maps the Lightning app's data dir to /lnd:ro), not a copy — so when LND
 * regenerates the cert, this path shows the new bytes immediately, with no
 * restart and no remount. That fact is what makes both the hash-gated client
 * rebuild and the expiry check possible at all.
 */
export const TLS_CERT_PATH = path.join(LND_DIR, "tls.cert");
