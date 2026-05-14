# BitCorn Operator Runbook

Operational procedures for treasury operators running BitCorn Lightning installations. Sections are appended as new operator concerns surface in releases; each section is self-contained and references its design source. Operator-facing procedures that span the application + Worker + Cloudflare surfaces live here; per-feature operator setup (e.g., Coinbase Auto-Buy wiring) continues to live in its own dedicated guide under `docs/`.

---

## Cloudflare Tunnel — Production Operation (Stage 4 / v1.16.0+)

**Applies from:** v1.16.0 onward.
**Design source:** `bitcorn-research/specs/2026-05-16-cloudflare-tunnel-hardening.md`; `bitcorn-research/investigations/2026-05-15-worker-rendezvous-reachability-gap.md`.

### Overview

Before v1.16.0, the treasury's `api_url` (the URL members fetch JWT tokens from) was published as the tailnet-private IP of the treasury host. Members on the same Tailscale network as the treasury reached it fine. Members on a *different* tailnet — which is most real-world members, since each Bitcorn member runs their own Umbrel on their own tailnet — fetched the `api_url` from the Cloudflare Worker successfully but then couldn't connect to it. Their `tokenRefresh` polled, hit transport-error, polled again, hit the same error, and never recovered.

v1.16.0 fixes this by exposing the treasury's API through a **named Cloudflare Tunnel** with a stable DNS name on the operator's domain. The published `api_url` becomes `https://treasury.<your-domain>` (or whatever subdomain you pick). Cross-tailnet members hit a Cloudflare-edge address, which routes through the tunnel to your treasury, regardless of where the member sits on the public internet.

**What changes for the operator:**
- A new `cloudflared` container runs alongside the existing Bitcorn services.
- You need a Cloudflare account and a domain whose DNS is hosted on Cloudflare (free tier suffices).
- You publish the new `https://treasury.<your-domain>` URL to the Worker as `TREASURY_API_URL`.
- One new environment variable: `TUNNEL_TOKEN`.

**What does not change for members:**
- No member-side action is required. Members already running v1.15.x self-heal automatically once the Worker's `TREASURY_API_URL` updates — their cached value refreshes on the next 12-hour tick, or sooner if the old URL has stopped responding.

---

### First-time setup

These steps stand up Phase 4 from scratch. Allow about 30 minutes if you're new to Cloudflare Tunnel; under 15 minutes if you've used it before.

**Prerequisites you arrange out-of-band:**
- A Cloudflare account (sign up at `dash.cloudflare.com` if needed — free tier is fine).
- A domain whose authoritative nameservers point at Cloudflare. The domain can be registered through any registrar; what matters is that Cloudflare is the DNS provider. If you're new to Cloudflare, the dashboard walks you through adding the domain and switching nameservers; allow up to 24 hours for nameserver propagation if you're starting from scratch.

#### 1. Create the tunnel

In the Cloudflare dashboard:

1. Navigate to **Zero Trust → Networks → Tunnels → Create a tunnel**.
2. Choose **Cloudflared** as the connector type.
3. Name the tunnel `bitcorn-treasury` (or whatever convention you prefer — see "Multi-treasury operators" below if you run more than one).
4. Save and continue. The next screen shows the tunnel's `TUNNEL_TOKEN` (a long base64-encoded string starting with `eyJ...`).

#### 2. Copy the `TUNNEL_TOKEN`

Copy the full token string. You'll paste it into the Bitcorn environment file in the next step. Don't worry about which CLI install instructions Cloudflare shows you on this screen — the Bitcorn app supplies its own cloudflared container; you only need the token.

#### 3. Add `TUNNEL_TOKEN` to your environment

Open the Bitcorn environment file (the same file holding `VALUATION_SUBMIT_HMAC`, etc. — on Umbrel this lives at `~/umbrel/app-data/bitcorn-lightning-node/.env`) and add:

```
TUNNEL_TOKEN=eyJh...<long string from step 2>...
COMPOSE_PROFILES=tunnel
```

The `COMPOSE_PROFILES=tunnel` line activates the cloudflared sidecar; without it, the sidecar stays off and the rest of the stack runs unchanged. Paste the token with **no surrounding quotes** and **no trailing whitespace** — a stray trailing newline will corrupt the token and cloudflared will fail to authenticate.

#### 4. Configure the tunnel's public hostname

Back in the Cloudflare dashboard, on the tunnel's configuration screen:

1. Click the **Public Hostname** tab.
2. Click **Add a public hostname**.
3. Fill in the subdomain (e.g., `treasury`) and select your domain from the dropdown. The full hostname becomes `treasury.<your-domain>`.
4. Set **Type** to `HTTP`.
5. Set **URL** to `bitcorn-lightning-node_api_1:3101`. **This is the gotcha** — see Troubleshooting → "Full container name gotcha" below. Use the full container name (project-prefixed), not just the service name.
6. Save.

Cloudflare automatically creates a CNAME record on the DNS side pointing `treasury.<your-domain>` at the tunnel's internal address. If your zone is configured correctly, this propagates in seconds.

#### 5. Start the Bitcorn stack with the tunnel profile

Bring the stack up with the tunnel profile enabled:

```
docker compose --profile tunnel up -d
```

If you set `COMPOSE_PROFILES=tunnel` in step 3, plain `docker compose up -d` works too — the env-var picks up the profile automatically. The `tunnel` profile gates the `cloudflared` service. Without the profile, the cloudflared container does not start — operators who don't want Phase 4 (e.g., domain-less operators, or operators staying on Phase 1) leave `COMPOSE_PROFILES` unset and get the same shape as v1.15.x.

If you run the Bitcorn stack via the Umbrel app store rather than direct `docker compose`, consult the Umbrel-app integration documentation for how to enable the tunnel profile — that wiring is out of scope for this runbook.

#### 6. Verify the tunnel is connecting

Check the cloudflared container logs:

```
docker compose logs cloudflared
```

Within ~30 seconds of startup, you should see lines like:

```
INF Connection registered connIndex=0 ip=<cloudflare-edge-ip> ...
INF Registered tunnel connection connIndex=1 ...
```

If you see authentication errors, the `TUNNEL_TOKEN` is wrong — re-copy from the dashboard and try again. If you see no connection-registered messages and no errors, check your outbound HTTPS connectivity to Cloudflare.

#### 7. Verify the tunnel serves traffic

From any internet-connected machine (your laptop is fine):

```
curl https://treasury.<your-domain>/treasury-info
```

You should see a JSON response with `lightning_pubkey`, `api_url`, and `subscription_public_key` fields. The `api_url` field still points at the *old* URL (whatever the Worker is currently serving — likely your previous Phase 1 ephemeral URL or a tailnet-private IP); that's expected and will be fixed in step 8.

If `curl` returns a Cloudflare error page (e.g., "Argo Tunnel error 1033"), the tunnel isn't routing yet — go back and check steps 4 and 6.

#### 8. Update the Worker `TREASURY_API_URL` secret

Now that you've confirmed the tunnel works, point the Worker at it:

```
cd cloudflare-worker
npx wrangler secret put TREASURY_API_URL
# When prompted, paste:
# https://treasury.<your-domain>
npx wrangler deploy
```

#### 9. Verify the Worker is publishing the new URL

```
curl https://<your-worker-url>/treasury-info
```

The `api_url` field should now show `https://treasury.<your-domain>`. If it still shows the old URL, the Worker hasn't re-deployed cleanly — re-run `npx wrangler deploy` and check `npx wrangler tail` for errors.

#### 10. Restart the treasury to confirm sync

```
docker compose restart api
```

Watch for `[SUBSCRIPTION_KEYPAIR_SYNC] in sync` in the treasury logs (this is the same sync-check log the 5a.1 setup uses; the underlying mechanism is unchanged).

#### 11. Cross-tailnet verification

This is the critical end-to-end test that earlier verification gates can't catch — see the "Verification-discovers-bugs" two-gate policy in `BITCORN_CONTEXT.md` §4. Confirm a real member node on a different tailnet can reach the treasury:

- Have a test member node on a different Tailscale network than the treasury (or any non-treasury network position — a cloud VM works too).
- Confirm the member's Subscription panel renders the actual current tier (not "couldn't reach the treasury" — see Troubleshooting → "Members on different tailnets can't reach the treasury" if it does).
- Tail the member's logs and confirm `workerFetch` calls succeed with 200 responses, and `tokenRefresh` completes successfully.

If this works, Phase 4 is live. The remaining cleanup (stopping any Phase 1 ephemeral tunnel you had running) is covered in the Migration section.

---

### Migration from Phase 1 (ephemeral `trycloudflare.com`)

If you've been running the Phase 1 ephemeral tunnel — an unauthenticated `cloudflared tunnel --url ...` process producing a rotating `trycloudflare.com` URL — migrate to Phase 4 with these steps. **Set up Phase 4 in parallel first; only tear down Phase 1 after Phase 4 is verified working.** This keeps member service intact throughout the transition.

#### 1. Complete first-time setup steps 1–7

Set up the named tunnel without yet updating the Worker secret. After step 7, the named tunnel is serving alongside your existing ephemeral one. The Worker still points at the ephemeral URL.

#### 2. Independently verify the named tunnel works

`curl https://treasury.<your-domain>/treasury-info` should succeed. If it doesn't, debug Phase 4 before going further — your existing members are still being served by Phase 1, so there's no rush.

#### 3. Cut over the Worker secret

`npx wrangler secret put TREASURY_API_URL` + `npx wrangler deploy` per first-time setup step 8.

#### 4. Watch members self-heal

Members' cached `api_url` values refresh on the normal 12-hour tick, or sooner if the old ephemeral URL has stopped responding (which it will, once you tear down Phase 1). No member-side operator action is required.

You can confirm self-heal is happening by tailing the member node logs (if you operate one or have a test member) and watching for `tokenRefresh` calls to start hitting the new URL.

#### 5. Wait for safety margin (optional)

Give it 30–60 minutes after the Worker re-deploy. Long enough that any active members have at least one tokenRefresh cycle on the new URL; short enough that you don't forget you have an ephemeral tunnel still running.

#### 6. Tear down Phase 1

Stop the manual `cloudflared tunnel --url ...` process. If you had it running under `systemd`, `tmux`, or similar, terminate it. The named tunnel keeps serving; members are unaffected.

#### 7. Verify cleanup

Run `ps aux | grep cloudflared` (or equivalent for your OS) on the treasury host. The only cloudflared process you should see is the one running inside the Bitcorn docker-compose `cloudflared` service's container (named `bitcorn-tunnel`). If you see a separate process (the old Phase 1 ephemeral), kill it.

---

### Health monitoring

#### Where to look for tunnel health

**cloudflared container logs.** Steady-state look:

```
docker compose logs --tail 50 cloudflared
```

A healthy tunnel logs `Connection registered` for each connector once at startup and then is mostly silent (occasional heartbeats). Repeated `Connection lost` / `Reconnecting` messages indicate trouble.

**Cloudflare dashboard tunnel status.** Zero Trust → Networks → Tunnels → your tunnel. The status column shows `HEALTHY`, `DEGRADED`, or `DOWN`. Click the tunnel for per-connector status and recent connection events.

**End-to-end smoke test.** From any internet-connected machine:

```
curl -sI https://treasury.<your-domain>/treasury-info
```

A `200 OK` response confirms the full path from public internet → Cloudflare edge → tunnel → treasury API → response works.

#### Common failure signatures

| Symptom | Likely cause | Where to look |
| --- | --- | --- |
| `curl` returns `Cloudflare error 1033` | Tunnel is offline (cloudflared not running or not connected) | cloudflared container logs; Cloudflare dashboard tunnel status |
| `curl` returns `Cloudflare error 502` or similar 5xx | Tunnel is up but can't reach the target (wrong Public Hostname routing target, or the api container is down) | Cloudflare dashboard Public Hostname config; `docker compose ps api` |
| `curl` returns 200 but member panel shows "Couldn't reach the treasury" | Worker `TREASURY_API_URL` still pointing at the old URL, or member's cached value hasn't refreshed yet | `curl https://<your-worker-url>/treasury-info` and check the `api_url` field; check member's `tokenRefresh` logs |
| cloudflared logs show authentication errors | `TUNNEL_TOKEN` is wrong or has been rotated | Re-copy `TUNNEL_TOKEN` from the Cloudflare dashboard, update environment file, restart cloudflared |
| cloudflared logs show `dial tcp: lookup bitcorn-lightning-node_api_1: no such host` | Routing target uses a name cloudflared can't resolve | Public Hostname target — see Troubleshooting → "Full container name gotcha" below |

---

### Rollback procedures

If Phase 4 deploys badly — named tunnel can't be created, DNS doesn't resolve, traffic isn't routing — you can revert to a Phase 1 ephemeral tunnel in under 10 minutes. This restores member service while you debug the Phase 4 setup at leisure.

#### Fast rollback to Phase 1

1. **Stop the Phase 4 cloudflared container:**

   ```
   docker compose stop cloudflared
   ```

2. **Start an ephemeral tunnel manually:**

   ```
   cloudflared tunnel --url http://bitcorn-lightning-node_api_1:3101
   ```

   This requires cloudflared installed on the host (outside docker). Cloudflare will return a new `<random>.trycloudflare.com` URL in the output.

3. **Update the Worker secret to the ephemeral URL:**

   ```
   npx wrangler secret put TREASURY_API_URL
   # Paste the new https://<random>.trycloudflare.com URL
   npx wrangler deploy
   ```

4. **Wait for member self-heal.** Cached `api_url` values refresh within 12 hours or sooner on transport-error.

5. **Diagnose Phase 4 at leisure.** Member service is restored on Phase 1; you have time to figure out what went wrong with the named tunnel before re-attempting.

#### Recovery from a deleted tunnel (worst case)

If the named tunnel is deleted from the Cloudflare dashboard (e.g., by accident, or by a colleague who didn't know it was load-bearing), recovery takes about 20 minutes:

1. Recreate the tunnel in the dashboard with the same name.
2. Copy the new `TUNNEL_TOKEN`.
3. Update the environment file with the new token.
4. Re-add the Public Hostname routing rule (same hostname, same `bitcorn-lightning-node_api_1:3101` target).
5. Re-create or verify the DNS CNAME record (the dashboard usually offers this with one click).
6. Restart the cloudflared container: `docker compose restart cloudflared`.
7. If you kept the same subdomain (e.g., `treasury.<your-domain>`), no Worker secret update is needed.

If you need member service back faster than the 20-minute recovery, use the Phase 1 fallback above (~10 minutes) and recreate the named tunnel afterward.

---

### Troubleshooting

#### Members on different tailnets can't reach the treasury

This is the bug Phase 4 was designed to fix. If you're seeing it after a v1.16.0 deploy, it means Phase 4 isn't fully active.

**Diagnostic checklist:**

1. **Is the Worker publishing the new URL?**
   ```
   curl https://<your-worker-url>/treasury-info
   ```
   Check the `api_url` field. If it's the old URL, run first-time setup step 8.

2. **Is the named tunnel serving?**
   ```
   curl https://treasury.<your-domain>/treasury-info
   ```
   Should return the same JSON. If it doesn't, check tunnel health (above).

3. **Are members getting the new URL on token refresh?** Check a member's `tokenRefresh` logs. The HTTP request should go to `https://treasury.<your-domain>`, not to the old URL. If members are still hitting the old URL, their cached `api_url` hasn't refreshed yet — wait ~12 hours (the natural refresh cadence) or force-refresh via the panel's "Refresh now" button.

#### Full container name gotcha for Public Hostname routing

When you configure the tunnel's Public Hostname in the Cloudflare dashboard, the "URL" field — what cloudflared forwards traffic to — needs to be the **full container name** of the api service's container, not the short service name.

The short service name (`api`) might resolve inside Docker if cloudflared and the api service share a default network. But the bitcorn-lightning-node compose setup joins Umbrel's shared `umbrel_main_network`, where other Umbrel apps may also register a service alias called `api` — that collision risk is what makes the full container name (`bitcorn-lightning-node_api_1`) the safe target. Same discipline as the existing `LOOP_GRPC_HOST: bitcorn-lightning-node_loopd_1` setting in the compose file.

**Wrong (may resolve to the wrong container on Umbrel's shared network, or fail with `dial tcp: lookup ... no such host`):**

```
URL: api:3101
```

**Right:**

```
URL: bitcorn-lightning-node_api_1:3101
```

If you see `dial tcp` errors in cloudflared logs, or if you see `502` responses from Cloudflare with traffic clearly reaching the tunnel, this is almost certainly the cause. Update the Public Hostname URL in the dashboard, save, and re-test.

#### cloudflared container restarts cause brief outage

A `docker compose restart cloudflared` takes about 10–30 seconds for the tunnel to fully re-establish. During this window, in-flight member requests fail with the panel's `transport_unreachable` view. Members self-heal automatically once the tunnel is back; no operator action needed.

If you're doing maintenance and want to avoid this window, you can run a Phase 1 ephemeral tunnel as a backup during the maintenance — but this is overkill for normal cloudflared updates.

#### `TUNNEL_TOKEN` ended up in a git commit

The `TUNNEL_TOKEN` is a credential. If you committed it to a public (or worse, mirrored) repository:

1. Rotate the token immediately: in the Cloudflare dashboard, delete the tunnel and create a new one. (Cloudflare does not provide token-rotation-in-place for tunnels; the rotation is "delete + recreate.")
2. Update `TUNNEL_TOKEN` in the environment file.
3. Update the Public Hostname routing on the new tunnel.
4. Restart cloudflared.
5. Remove the credential from git history per your operational security practice.

Threat-model note: a leaked `TUNNEL_TOKEN` lets an attacker run their own cloudflared and intercept the routing. They cannot, however, forge JWTs (those are signed by the treasury's Ed25519 key) or impersonate the treasury's identity. The blast radius is "MITM the connection between Cloudflare and the operator's network position" — bad, but bounded.

#### Operator wants to verify the tunnel works without disrupting members

The `curl` smoke test (`curl -sI https://treasury.<your-domain>/treasury-info`) is non-disruptive — it's just a fetch of a public endpoint. Run it whenever you want a quick health check. The Cloudflare dashboard's status column is also a good non-invasive indicator.

For deeper diagnostics, the cloudflared container logs are detailed but verbose; consider `docker compose logs --tail 50 cloudflared` rather than tailing live unless you're actively debugging.

---

### Multi-treasury operators

Operators running multiple treasuries (e.g., dev + prod, or per-customer-deployment) need a tunnel naming convention. The recommended pattern:

- **One named tunnel per treasury.** Each treasury's docker-compose has its own `TUNNEL_TOKEN`. No shared tunnel state.
- **Subdomain convention:** `treasury-prod.<your-domain>`, `treasury-dev.<your-domain>`, etc. Each gets its own Cloudflare-side tunnel, its own Public Hostname routing rule, and its own DNS CNAME.
- **Worker secret naming:** unchanged. Each Worker deployment has its own `TREASURY_API_URL` pointing at that deployment's tunnel.

Per-deployment tunnels keep failures isolated — a problem with one treasury doesn't affect the other. The cost is one `TUNNEL_TOKEN` per treasury; the benefit is independent operation.

---

### What this section doesn't cover

These items are explicitly out of scope for the v1.16.0 runbook:

- **Operators without a Cloudflare-managed domain.** Continue running the Phase 1 ephemeral `trycloudflare.com` URL manually as before; Phase 4 is not available without a managed domain.
- **Cloudflare Access** (per-request auth on top of the tunnel). Bitcorn's JWT layer handles auth at the application level; Cloudflare Access is unnecessary and not configured.
- **Tunnel-credential rotation automation.** Manual operator action only — see "TUNNEL_TOKEN ended up in a git commit" above for the procedure when rotation is actually needed.
- **Sync-state visibility in the admin UI.** Continuous Worker-sync-status display is Stage 5b scope; until then, the cloudflared logs and the Cloudflare dashboard are the diagnostic surfaces.

---

*End of v1.16.0 runbook content. Subsequent sub-stages or release work that touches operator concerns will produce additional sections via the same handoff pattern.*
