# Auto-Buy — Operator Setup Guide

A checklist for wiring up Auto-Buy on a BitCorn Lightning node: on Coinbase (Steps 1–5 below), or on Kraken ([§ Kraken](#kraken)).

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

## Step 4 — Configure Strategy

Still on the Auto-Buy page, open the **DCA Strategy** tab. The **Strategy** panel sets the pace of buying:

- **Base unit (USD)** — amount per buy. Use `$2` for the first smoke test.
- **Frequency** — `Daily` for testing.
- **Zone Buy Multipliers** — how much the base unit is scaled in each valuation zone.

Click **Save Strategy**.

**The safety caps are not configurable.** The single-buy, rolling 7-day and rolling 30-day caps are fixed code defaults in this release; `app/api/src/config/env.ts` is the source of truth for their values. They cannot be changed from the UI or from the Umbrel `.env` — the node's `docker-compose.yml` does not pass them into the API container, so a value set in `.env` has no effect. What you control is the pace above: base unit, frequency and zone multipliers. For a small first test, keep the base unit small.

**To turn auto-buy off**, click **Pause** in the master control at the top of the DCA Strategy tab. That stops the scheduler from placing new buys until you click **Enable** again. Editing `.env` does not turn it off: `AUTOBUY_ENABLED` is set to the literal `"true"` in the node's `docker-compose.yml`, not read from `.env`.

## Step 5 — Enable & First Buy

1. **Wait for the activation hold from Step 3.6 to clear** (24–72h). Don't trigger Execute Now before this — the buy will succeed but the eventual sweep at T+72h will be rejected by Coinbase.
2. Click the **Enable** button in the master control at the top of the DCA Strategy tab.
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

## Kraken

Auto-Buy can buy on **Kraken** instead of Coinbase. One exchange is active at a time; the **Exchange** panel at the top of the DCA Strategy tab shows which one and switches between them. Switching pauses Auto-Buy, and you can't switch while a buy or withdrawal is in progress.

This section is also the exact setup a farm follows for its Kraken API key. Kraken's own pages are linked at each step (all read 2026-11-24).

### What's different on Kraken

- **USD only.** Kraken buys are paid from USD. USDC on Kraken is shown on the Kraken card but never used, and a USDC currency preference buys with USD.
- **A 7-day hold** before each buy is swept to your node, matching the hold Kraken puts on ACH deposits. The history shows "Kraken 7-day hold ends …".
- **Minimums.** A buy below Kraken's minimum is skipped (badge **BELOW MIN**) and an alert says so; it is never rounded up. A sweep below Kraken's minimum withdrawal waits for the next sweep day. The node reads both minimums from Kraken at runtime.
- **A low-funds warning** when your USD balance covers fewer than 2 of your next buys at the current zone. While Auto-Buy is enabled, the node reads the Kraken balance once per scheduler tick (about every 15 minutes).
- **Withdrawals can wait for approval** (see [below](#withdrawals-waiting-for-approval)).

### Step K1 — Unlock Kraken's Global Settings Lock, if it's on

The lock blocks adding API keys and withdrawal addresses. Unlocking takes 1 to 29 days (3 by default), so start it first. [What is the Global Settings Lock?](https://support.kraken.com/articles/201396877-what-is-the-global-settings-lock-gsl-)

### Step K2 — Choose Kraken and copy your node's address

1. Dashboard → **Auto-Buy** → **DCA Strategy**. In the **Exchange** panel, click **Switch to Kraken**.
2. The **Kraken** panel shows your node's withdrawal address (`bc1q...`). Copy it.

### Step K3 — Save your node's address in Kraken

Save the address before you create the key, so connecting the key finds it in one go. The node can't add the address itself (it never holds Add Withdrawal Addresses), so you save it in Kraken:

1. In Kraken: **Withdraw** → **Bitcoin** → **Add new withdrawal address**.
2. Paste the address from the Kraken panel and give it a unique label.
3. Confirm it. From a device Kraken doesn't trust, Kraken emails a confirmation link that is valid for one hour. [Adding and confirming a withdrawal address](https://support.kraken.com/articles/360000672863-adding-and-confirming-a-new-cryptocurrency-withdrawal-address)

Keep the address under one Bitcoin withdrawal method only; if it is saved under more than one, the node refuses rather than guess.

### Step K4 — Create the API key

In Kraken: account menu → **Settings** → **API** → **Create API key**. [How to create an API key](https://support.kraken.com/articles/how-to-create-an-api-key-on-kraken-pro)

Grant **exactly these five permissions**:

- **Query Funds**
- **Withdraw Funds**
- **Query Open Orders & Trades**
- **Query Closed Orders & Trades**
- **Create & Modify Orders** (called **Modify Orders** on some screens)

**Never grant Add Withdrawal Addresses or Update Withdrawal Addresses** (the second appears only on Organization keys). The node refuses a key that holds either, or that lacks any of the five: the node must never be able to change where a withdrawal goes. [Withdrawal addresses API permission](https://support.kraken.com/articles/withdrawal-addresses-api-permission)

On the same screen:

- **Don't add 2FA to the key.** The node's client doesn't support it.
- **Leave Key Expiration unset**, or the key stops working on its date.
- **Leave the nonce window unset.** The node sends every request from one serialized nonce, so it needs no window. [Authentication](https://docs.kraken.com/exchange/guides/rest/authentication)
- **IP address restriction only if your node has a static IP.** If the node's IP changes, the key stops working.

### Step K5 — Connect the key in BitCorn

1. In the **Kraken** panel, paste the **API key** and the **private key** from Kraken, then click **Connect Kraken**. The node checks the key's permissions with Kraken before it stores anything, then looks your node's address up among the addresses saved in Kraken.
2. It should say "Connected. Your node's address is saved and verified on Kraken." If it says the address isn't saved or isn't verified yet, finish [Step K3](#step-k3--save-your-nodes-address-in-kraken), then press **Verify**.

### Step K6 — Schedule one recurring ACH deposit

In Kraken, set up one recurring ACH deposit from your bank. Set the deposit to cover a full interval of buys at your highest zone multiplier, plus a margin — for example, weekly $100 base buys with a 2× top zone means at least $200 a week. [Recurring ACH deposits](https://support.kraken.com/articles/recurring-ach-deposits)

- **Each deposit can be withdrawn seven days after it arrives**, and the hold covers BTC bought with that money, up to the deposit's amount. Auto-Buy's 7-day hold counts from each buy, which comes after the deposit, so it outlasts Kraken's.
- Kraken limits ACH by state; check Kraken's ACH page for your state.
- **Open condition: whether a business account can use recurring ACH deposits** is not stated on Kraken's pages. Confirm it with Kraken before relying on it.

### Step K7 — Pick a base buy that clears Kraken's minimum

Kraken's minimum order changes without notice, so the node reads it live. When you save a key or press Verify, the Kraken panel warns if your smallest non-zero buy (base × the smallest zone multiplier) is below the minimum at today's price. As a starting point, a **base buy of at least $50** keeps the smallest zone buy (0.25×) at about $12.50. [Minimum order sizes](https://support.kraken.com/articles/205893708-minimum-order-size-volume-for-trading), [Cost minimum](https://support.kraken.com/articles/12425041458708-cost-minimum-for-trading)

Then set the frequency and zone multipliers as in [Step 4](#step-4--configure-strategy), and click **Enable** in the master control.

### Withdrawals waiting for approval

On a Kraken **Organization** account with an approval policy, each withdrawal waits until a member approves it. Auto-Buy then shows a warning, "Withdrawal waiting for approval", and keeps checking: once the withdrawal is approved it completes as normal; if it's rejected, the BTC stays on Kraken and the sweep is marked failed. [Organization service users](https://support.kraken.com/articles/organization-service-users)

### Kraken failure modes

| Symptom | Cause | Fix |
|---|---|---|
| "This key has permissions it must not have" on Connect | Add or Update Withdrawal Addresses granted | Create a new key with only the five (Step K4) |
| "This key is missing: …" on Connect | One of the five not granted | Create a new key with all five |
| "Save your node's address … then press Verify here." | The address isn't saved in Kraken yet | Step K3, then press Verify |
| "… saved on Kraken but not verified yet" | Kraken's confirmation not done | Confirm it in Kraken, then press Verify |
| **BELOW MIN** rows and "Buy skipped: below Kraken's minimum" | Base × multiplier under Kraken's minimum | Raise the base buy or that zone's multiplier (Step K7) |
| "Low funds on Kraken" | USD covers fewer than 2 next buys | Add USD, or raise the recurring deposit (Step K6) |
| "Auto-Buy paused: Kraken key refused" | Key deleted, changed, or used by another app | Create a new key and connect it |
| "Paused: exchange switched" | The exchange was switched | Set up the new exchange, then turn Auto-Buy back on |
| "Withdrawal failed: your BTC is safe on Kraken" | Kraken didn't send the sweep (for example, a review hold) | Withdraw by hand in Kraken to your node's saved address; Auto-Buy won't retry it |
| "Withdrawal outcome unknown" | Kraken didn't confirm the sweep | Check Withdrawals in Kraken **before** withdrawing anything by hand |

## Reference

- `docs/COINBASE_INTEGRATION.md` — Cloudflare Worker + Onramp architecture
- `docs/AUTOBUY_HANDOFF.md` — engineering handoff with deeper context
- `app/api/src/autoBuy/scheduler.ts` — 5-step state machine
