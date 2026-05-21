# Coinbase Auto-Buy — Operator Setup Guide

A one-page checklist for wiring up Coinbase Auto-Buy on a BitCorn Lightning node.

**Active work: ~30 minutes.** Two waiting periods land in between: Coinbase's address activation hold (24–72h) and the first sweep after a buy (72h). The hands-on steps fit in one sitting.

## Prerequisites

- Verified **coinbase.com** account (KYC complete) with a USD balance ≥ $10
- Operator access to the BitCorn Lightning dashboard with the **Treasury** role
- Phone or hardware key registered for Coinbase 2FA
- BitCorn Lightning app installed and running on Umbrel

## Step 1 — Create a CDP API Key

1. Go to **portal.cdp.coinbase.com** and sign in with your normal Coinbase login. *No separate developer account is required* — same credentials, same KYC.
2. Click **Create API key**.
3. Nickname it `BitcornAutoBuy`. Project: `Primary` is fine.
4. **CRITICAL — Advanced Settings → Signature algorithm**: select **ECDSA**, *not* the default Ed25519. The BitCorn scheduler signs with ECDSA only; Ed25519 keys won't save. (Coinbase's own dialog flags this for Advanced Trade users.)
5. **API restrictions** — enable all three:
   - **View** (read balances)
   - **Trade** (place buy orders)
   - **Transfer** (withdraw BTC)

   A key missing **Transfer** passes save-time verification but fails silently 72h later at the sweep step.
6. **IP allowlist** — optional. If you have a static home IP, add it (`curl ifconfig.me` from your Umbrel host). Most residential ISPs rotate; leave blank for unattended operation. JWT signing is the real auth boundary.
7. Click **Create**. Coinbase downloads a JSON file. Keep it — you can't re-download it.

## Step 2 — Connect the Key in BitCorn

1. Dashboard → **Auto-Buy** in the sidebar.
2. The Coinbase Integration card shows "Disconnected" with a textarea.
3. Open the downloaded JSON, copy the entire contents (including braces), paste into the textarea.
4. Click **Save & Connect**. Card flips to "Connected, not whitelisted" and shows your dedicated deposit address (`bc1q...`).

## Step 3 — Whitelist the Deposit Address on Coinbase

The address in the BitCorn card has to be on Coinbase's withdrawal allowlist. **This entire step happens on coinbase.com, not in our UI** — the "I've whitelisted this in Coinbase" button only flips a local flag.

1. Sign into **coinbase.com** → top-right avatar → **Settings**.
2. Open **Privacy & data → Allow list** (or search "allowlist" in Settings).
3. Toggle **Allow list** on if it isn't already.
4. Click **Add address** → asset **Bitcoin (BTC)** → paste the BitCorn deposit address → label it `BitCorn Lightning Node`.
5. Confirm with 2FA. Coinbase enforces this — there's no API path around it.
6. **Coinbase holds new addresses 24–72h before the first withdrawal will succeed.** This activation hold runs in parallel with the rest of setup; nothing else blocks on it.
7. Back in BitCorn → click **I've whitelisted this in Coinbase**. Card flips to "Connected & Whitelisted".

## Step 4 — Configure Strategy & Caps

Still on the Auto-Buy page, scroll to **DCA Strategy**:

- **Base unit (USD)** — amount per buy. Use `$2` for the first smoke test.
- **Frequency** — `Daily` for testing.

For the first run, also lock down the safety caps. SSH into Umbrel and edit `/home/umbrel/umbrel/app-data/bitcorn-lightning-node/.env`:

```
AUTOBUY_MAX_SINGLE_BUY_USD=3
AUTOBUY_MAX_7D_USD=10
AUTOBUY_MAX_30D_USD=30
```

Then restart so the API picks up the new env:

```bash
sudo umbreld client apps.restart.mutate --appId bitcorn-lightning-node
```

Click **Save** in the Strategy panel.

## Step 5 — Enable & First Buy

1. **Wait for the activation hold from Step 3.6 to clear** (24–72h). Don't trigger Execute Now before this — the buy will succeed but the eventual sweep at T+72h will be rejected by Coinbase.
2. Flip the master **Enable** toggle.
3. Click **Execute Now** and confirm.
4. Watch the Purchase History row walk through the states:

   ```
   PLACED → FILLED → AWAITING-WITHDRAW → (T+72h) SWEEP → WITHDRAWING → WITHDRAWN
   ```

5. Live debug from Umbrel:

   ```bash
   sudo docker logs -f bitcorn-lightning-node-api-1 | grep autobuy
   ```

## Common Failure Modes

| Symptom | Cause | Fix |
|---|---|---|
| `key_name_and_private_key_required` on Save | Ed25519 key (default) | Recreate as ECDSA |
| `verification_failed` on Save | Missing View permission, or wrong key type | Regenerate key with View + Trade + Transfer, ECDSA |
| `failed_buy` row in history | Missing Trade permission, or USD wallet empty | Check permissions; deposit USD via coinbase.com |
| `failed_withdraw` ~72h after a buy | Address not on Coinbase allowlist, or activation hold still active | Re-verify Step 3, wait the hold |
| `paused_reason: no_credentials` | DB row missing or `master.key` rotated | Re-paste the CDP JSON |
| Scheduler auto-paused after 3 fails | `AUTOBUY_FAILURE_PAUSE_THRESHOLD` tripped | Diagnose underlying error, re-enable |

## Reference

- `docs/COINBASE_INTEGRATION.md` — Cloudflare Worker + Onramp architecture
- `docs/AUTOBUY_HANDOFF.md` — engineering handoff with deeper context
- `app/api/src/autoBuy/scheduler.ts` — 5-step state machine
