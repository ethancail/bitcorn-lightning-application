#!/usr/bin/env bash
# recredit-check — treasury read. READ-ONLY. Prints counts and anomalies only:
# (Committed under ruling O5 (a), bitcorn-research specs/2026-11-13-recredit-
# check-credit-from-confirmation-time-spec.md §8. Original sha256 2e6c71f2…afd;
# changed since: check 3 replays on-chain rows from confirmed_at, and checks 3b
# and 3c were added. Check 3's replay rule is pinned by
# app/api/src/subscription/treasuryReadReplay.test.ts, which runs in CI.)
#
# no member names, pubkeys, addresses or txids (a member is an ordinal plus the
# first 8 hex of sha256(pubkey)).
#
# RUN ON: the TREASURY Umbrel node, in an SSH shell as the umbrel user:
#     bash treasury-read.sh
# Uses sudo for docker. Writes nothing: the database is opened by better-sqlite3
# with SQLITE_OPEN_READONLY plus PRAGMA query_only inside the running api
# container; in WAL mode a reader holds only a read mark, so the api's writer is
# never blocked. Every unmet precondition prints STOP and ends the run.

set -u
APP_ID="bitcorn-lightning-node"   # umbrel-app.yml `id:`

main() {
  local names count c img dsrc appdata umbrel_root f s

  names="$(sudo docker ps \
    --filter "label=com.docker.compose.project=${APP_ID}" \
    --filter "label=com.docker.compose.service=api" \
    --format '{{.Names}}')"
  count="$(printf '%s' "$names" | grep -c .)"
  if [ "$count" != "1" ]; then
    echo "STOP: expected exactly one api container labelled project=${APP_ID} service=api; found ${count}."
    echo "Containers whose name or image mentions bitcorn (for the operator to read, nothing chosen):"
    sudo docker ps --format '{{.Names}}\t{{.Image}}' | grep -i bitcorn
    return 1
  fi
  c="$names"

  img="$(sudo docker inspect -f '{{.Config.Image}}' "$c")"
  case "$img" in
    ghcr.io/ethancail/bitcorn-lightning-application/api:*) ;;
    *) echo "STOP: container ${c} runs image '${img}', not the Bitcorn api image."; return 1 ;;
  esac

  dsrc="$(sudo docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$c")"
  if [ -z "$dsrc" ]; then
    echo "STOP: container ${c} has no bind mount at /data."
    return 1
  fi
  appdata="$(dirname "$dsrc")"            # compose: ${APP_DATA_DIR}/data:/data
  umbrel_root="$(dirname "$(dirname "$appdata")")"

  echo "== installed version =="
  echo "api container                         ${c}"
  echo "running api image                     ${img}"
  if [ "$(basename "$appdata")" != "$APP_ID" ]; then
    echo "app-data dir                          ${appdata}  (basename is not ${APP_ID}: manifest and compose lines skipped, nothing guessed)"
  else
    f="${appdata}/docker-compose.yml"
    if sudo test -f "$f"; then
      echo "deployed compose api image            $(sudo grep -m1 -oE 'ghcr\.io/ethancail/bitcorn-lightning-application/api:[^[:space:]"]+' "$f" || echo 'no api image line')"
    else
      echo "deployed compose                      not found at ${f}"
    fi
    f="${appdata}/umbrel-app.yml"
    if sudo test -f "$f"; then
      echo "installed manifest version            $(sudo grep -m1 -E '^version:' "$f" || echo 'no version line')"
    else
      echo "installed manifest                    not found at ${f}"
    fi
    for s in "${umbrel_root}"/app-stores/*bitcorn-lightning-application*/"${APP_ID}"/umbrel-app.yml; do
      if [ -f "$s" ]; then
        echo "app-store clone (ADVERTISED, not installed) $(grep -m1 -E '^version:' "$s" || echo 'no version line')"
      fi
    done
  fi

  sudo docker exec -i -w /app "$c" node - <<'JS'
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

// Same path rule as app/api/src/db/index.ts:5-6.
const DB_DIR = process.env.DB_DIR ?? '/data/db';
const DB_PATH = path.join(DB_DIR, 'bitcorn.sqlite');
const out = (k, v) => console.log(String(k).padEnd(62), v);
console.log('== database ==');
out('DB_DIR in the api container', process.env.DB_DIR === undefined ? 'unset (default /data/db)' : 'set');
out('database file', DB_PATH);

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.log('STOP: cannot open the database read-only:', e.code || e.message);
}
if (db) {
  if (!db.readonly) throw new Error('STOP: connection is not read-only');
  db.pragma('query_only = ON');
  run(db);
  db.close();
}

function run(db) {
  const DAY = 86400000, TOL = 1000, BURST = 120000, GAP = 5 * 60000;
  const one = (s, ...a) => db.prepare(s).get(...a);
  const all = (s, ...a) => db.prepare(s).all(...a);
  const h8 = (pk) => crypto.createHash('sha256').update(pk).digest('hex').slice(0, 8);
  const iso = (ms) => (ms == null ? '-' : new Date(ms).toISOString());

  // ── identity guard ──────────────────────────────────────────────
  const node = one('SELECT pubkey, node_role FROM lnd_node_info WHERE id = 1');
  const tp = process.env.TREASURY_PUBKEY;
  const isTreasury = !!(node && tp && node.pubkey === tp);
  out('this node is the treasury (local pubkey = TREASURY_PUBKEY)', isTreasury ? 'yes' : 'NO');
  out('node_role recorded', node ? node.node_role : 'no lnd_node_info row');
  if (!isTreasury) { console.log('STOP: not the treasury database; no subscription checks run.'); return; }

  // ── guarantees and policy (item 4) ──────────────────────────────
  console.log('== guarantees and policy ==');
  const pol = one('SELECT price_sats, period_days, underpay_tolerance_pct, updated_at, first_run_acknowledged_at FROM subscription_policy WHERE id = 1');
  if (!pol) { console.log('STOP: no subscription_policy row'); return; }
  out('policy price_sats / period_days / tolerance_pct', `${pol.price_sats} / ${pol.period_days} / ${pol.underpay_tolerance_pct}`);
  out('equals the 036 seed (50000 / 30 / 95)', pol.price_sats === 50000 && pol.period_days === 30 && pol.underpay_tolerance_pct === 95 ? 'yes' : 'NO');
  out('first-run acknowledged (detector enabled)', pol.first_run_acknowledged_at != null ? 'yes' : 'NO');
  const applied = (f) => { const r = one('SELECT applied_at FROM migrations WHERE id = ?', f); return r ? r.applied_at : null; };
  const bumps = [
    ['036 seed', applied('036_member_subscription.sql')],
    ['042 bump', applied('042_subscription_grace_days_fresh.sql')],
    ['071 bump (only if worker was 7)', applied('071_subscription_grace_days_worker_30.sql')],
    ['first-run ack', pol.first_run_acknowledged_at],
  ].filter(([, t]) => t != null);
  const explain = (u) => {
    const hit = bumps.filter(([, t]) => Math.abs(u - t) <= 10000).map(([n]) => n);
    const later = bumps.filter(([n, t]) => t > u + 10000 && !n.startsWith('071')).map(([n]) => n);
    return `${hit.length ? 'matches ' + hit.join(', ') : 'matches NO known writer'}${later.length ? '; later bumps not reflected: ' + later.join(', ') : ''}`;
  };
  out('policy updated_at', iso(pol.updated_at));
  out('policy updated_at explained by a known writer', explain(pol.updated_at));
  out('  control: updated_at one hour after every known bump', explain(Math.max(...bumps.map(([, t]) => t)) + 3600000));
  const ix = (name) => { const r = one("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", name); return r ? (/UNIQUE/i.test(r.sql) ? 'present, UNIQUE' : 'present, NOT unique') : 'ABSENT'; };
  out('UNIQUE index subscription_payment(txid, vout)', ix('idx_subscription_payment_txid_vout'));
  out('UNIQUE index subscription_pending_attribution(txid, vout)', ix('idx_subscription_pending_txid_vout'));
  out('migrations 036 / 072 recorded', `${applied('036_member_subscription.sql') ? 1 : 0} / ${applied('072_subscription_founding_member_credit.sql') ? 1 : 0}`);

  // ── totals ──────────────────────────────────────────────────────
  console.log('== totals (a zero here means zero rows were looked at) ==');
  const members = all('SELECT member_pubkey, created_at, paid_through, current_tier FROM subscription ORDER BY created_at, member_pubkey');
  out('subscription rows (members)', members.length);
  out('members by tier', all('SELECT current_tier t, COUNT(*) n FROM subscription GROUP BY t ORDER BY t').map((r) => `${r.t}=${r.n}`).join(' ') || '-');
  out('ledger rows by kind', all('SELECT kind k, COUNT(*) n FROM subscription_payment GROUP BY k ORDER BY k').map((r) => `${r.k}=${r.n}`).join(' ') || '-');
  const oc = one("SELECT COUNT(*) n, COUNT(DISTINCT txid || ':' || vout) d, COUNT(DISTINCT member_pubkey) m FROM subscription_payment WHERE kind = 'onchain'");
  out('on-chain credits / distinct txid:vout / members paying', `${oc.n} / ${oc.d} / ${oc.m}`);
  out('pending-attribution rows', one('SELECT COUNT(*) n FROM subscription_pending_attribution').n);
  const histN = one('SELECT COUNT(*) n, MIN(recorded_at) a, MAX(recorded_at) b FROM lnd_node_info_history');
  out('sync history rows / first / last', `${histN.n} / ${iso(histN.a)} / ${iso(histN.b)}`);

  // ledger per member, in commit order (id)
  const ledger = all('SELECT member_pubkey, txid, received_at, confirmed_at, period_extension_days, amount_sats, kind, admin_reason FROM subscription_payment ORDER BY id');
  const byMember = new Map();
  for (const r of ledger) { if (!byMember.has(r.member_pubkey)) byMember.set(r.member_pubkey, []); byMember.get(r.member_pubkey).push(r); }
  const rowsOf = (m) => byMember.get(m.member_pubkey) || [];

  // ── writer shapes ───────────────────────────────────────────────
  console.log('== writer shapes (G = grandfather sentinel, F = founding credit, O = on-chain, A = other admin_override) ==');
  const shape = (rs) => {
    const s = new Set();
    for (const r of rs) {
      if (r.kind === 'onchain') s.add('O');
      else if (r.admin_reason === 'Stage 2 grandfather backfill at flip-day') s.add('G');
      else if (r.admin_reason === 'Founding member credit') s.add('F');
      else s.add('A');
    }
    return ['G', 'F', 'O', 'A'].filter((k) => s.has(k)).join(',') || 'none (never paid)';
  };
  const shapes = {};
  for (const m of members) { const k = shape(rowsOf(m)); shapes[k] = (shapes[k] || 0) + 1; }
  for (const k of Object.keys(shapes).sort()) out(`  ${k}`, shapes[k]);
  const g072 = applied('072_subscription_founding_member_credit.sql');
  out('G with no time credit while 072 is recorded (expect 0)', members.filter((m) => { const rs = rowsOf(m); return g072 && shape(rs) === 'G'; }).length);
  out('A: admin_override rows no code path writes (expect 0)', ledger.filter((r) => r.kind !== 'onchain' && r.admin_reason !== 'Stage 2 grandfather backfill at flip-day' && r.admin_reason !== 'Founding member credit').length);

  // ── check 1 ─────────────────────────────────────────────────────
  console.log('== check 1: more than one credit per output (key = txid:vout) ==');
  const SRC = 'SELECT txid, vout FROM subscription_payment WHERE txid IS NOT NULL';
  const dup = (src) => one(`SELECT COUNT(*) n FROM (SELECT txid, vout FROM (${src}) GROUP BY txid, vout HAVING COUNT(*) > 1)`).n;
  out('outputs credited more than once', dup(SRC));
  out('  control: + one synthetic duplicate (expect 1)', dup(`${SRC} UNION ALL SELECT 'ctl', 0 UNION ALL SELECT 'ctl', 0`));
  const cross = (x) => one(`SELECT COUNT(*) n FROM (${SRC}${x}) p JOIN (SELECT txid, vout FROM subscription_pending_attribution${x}) q USING (txid, vout)`).n;
  out('outputs in BOTH ledger and pending bucket', cross(''));
  out('  control: + one synthetic output in both (expect 1)', cross(" UNION ALL SELECT 'ctl', 0"));
  out('txids credited on more than one vout (info, legit)', one(`SELECT COUNT(*) n FROM (SELECT txid FROM (${SRC}) GROUP BY txid HAVING COUNT(DISTINCT vout) > 1)`).n);

  // ── check 2 ─────────────────────────────────────────────────────
  console.log('== check 2: an on-chain credit grants more days than its amount buys ==');
  const days = (amt, p) => Math.floor((amt / p.price_sats) * p.period_days);
  const SEED = { price_sats: 50000, period_days: 30, underpay_tolerance_pct: 95 };
  const onRows = ledger.filter((r) => r.kind === 'onchain');
  out('on-chain rows examined', onRows.length);
  out('rows over what the amount buys at the CURRENT policy', onRows.filter((r) => r.period_extension_days > days(r.amount_sats, pol)).length);
  out('rows over what the amount buys at the 036 SEED policy', onRows.filter((r) => r.period_extension_days > days(r.amount_sats, SEED)).length);
  out('rows credited below the current tolerance', onRows.filter((r) => r.amount_sats < (pol.price_sats * pol.underpay_tolerance_pct) / 100).length);
  out('  control: synthetic 1-price row granting period+1 days (expect 1)', [{ amount_sats: pol.price_sats, period_extension_days: pol.period_days + 1 }].filter((r) => r.period_extension_days > days(r.amount_sats, pol)).length);

  // ── check 3 ─────────────────────────────────────────────────────
  // Replays every writer of paid_through: allocation (pt = created_at, or
  // created_at + period for post-T3 grandfather, whose founding row carries the
  // period), 072 (founding row at credit time + period), and the detector
  // (pt = max(pt, confirmed_at) + days — computeNewPaidThrough with the
  // output's confirmation time, recredit-check). Order = commit order (id),
  // which is processing order; NOT confirmed_at order, which differs only in
  // the rescan residual and would not reproduce what the detector did.
  // One rule for rows on both sides of the release: before it, the detector
  // wrote confirmed_at = received_at = the detection time, its basis then.
  // Non-on-chain (admin_override) rows keep received_at, as before.
  console.log('== check 3: paid_through vs a replay of the ledger ==');
  // >>> REPLAY RULE — pinned by app/api/src/subscription/treasuryReadReplay.test.ts >>>
  const creditTime = (r) => (r.kind === 'onchain' ? r.confirmed_at : r.received_at);
  const replay = (m, rs) => rs.reduce((pt, r) => Math.max(pt, creditTime(r)) + r.period_extension_days * DAY, m.created_at);
  // <<< REPLAY RULE <<<
  const bound = (m, rs) => Math.max(m.created_at, ...rs.map(creditTime)) + rs.reduce((s, r) => s + r.period_extension_days * DAY, 0);
  const classify = (m, rs) => { const d = m.paid_through - replay(m, rs); return d > TOL ? 'over' : d < -TOL ? 'under' : 'match'; };
  const tally = { match: 0, over: 0, under: 0 }, flagged = [];
  let overBound = 0;
  members.forEach((m, i) => {
    const rs = rowsOf(m), c = classify(m, rs);
    tally[c]++;
    if (m.paid_through > bound(m, rs) + TOL) overBound++;
    if (c !== 'match') flagged.push({ ordinal: i + 1, id: h8(m.member_pubkey), class: c, shape: shape(rs), rows: rs.length, delta_periods: +((m.paid_through - replay(m, rs)) / (pol.period_days * DAY)).toFixed(3) });
  });
  out('members replayed (equals subscription rows)', tally.match + tally.over + tally.under);
  out('match / OVER / UNDER', `${tally.match} / ${tally.over} / ${tally.under}`);
  out('paid_through above order-free upper bound', overBound);
  const T = Date.UTC(2026, 0, 1);
  const cR = [{ kind: 'onchain', received_at: T, confirmed_at: T, period_extension_days: 30 }];
  out('  control: synthetic member 1 day over its ledger (expect over)', classify({ created_at: T, paid_through: T + 31 * DAY }, cR));
  out('  control: synthetic member 1 day under its ledger (expect under)', classify({ created_at: T, paid_through: T + 29 * DAY }, cR));
  out('  control: synthetic consistent member (expect match)', classify({ created_at: T, paid_through: T + 30 * DAY }, cR));
  const cReplayed = [{ kind: 'onchain', received_at: T + 3 * DAY, confirmed_at: T, period_extension_days: 30 }];
  out('  control: replayed row, received_at 3 days after confirmed_at (expect match)', classify({ created_at: T - DAY, paid_through: T + 30 * DAY }, cReplayed));
  if (flagged.length) console.table(flagged);

  // ── check 3b / 3c ───────────────────────────────────────────────
  // 3b: T_conf may lead detection only by the consensus bound on a block's
  // nTime (~2 h ahead of network time). Applies to every on-chain row: rows
  // written before the release have confirmed_at = received_at, so they pass.
  // 3c: the detector never writes an on-chain row without its confirmation time.
  console.log('== check 3b / 3c: confirmed_at on on-chain rows ==');
  const LEAD = 2 * 3600000;
  const leads = (rs) => rs.filter((r) => r.kind === 'onchain' && r.confirmed_at != null && r.confirmed_at > r.received_at + LEAD).length;
  const nulls = (rs) => rs.filter((r) => r.kind === 'onchain' && r.confirmed_at == null).length;
  out('on-chain rows with confirmed_at != received_at (confirmation-time basis; 0 = 3b vacuous)', onRows.filter((r) => r.confirmed_at != null && r.confirmed_at !== r.received_at).length);
  out('3b: on-chain rows with confirmed_at > received_at + 2 h (expect 0)', leads(onRows));
  out('  control: synthetic row confirmed 2 h + 1 s after detection (expect 1)', leads([{ kind: 'onchain', received_at: T, confirmed_at: T + LEAD + 1000 }]));
  out('  control: synthetic row confirmed 2 h after detection (expect 0)', leads([{ kind: 'onchain', received_at: T, confirmed_at: T + LEAD }]));
  out('3c: on-chain rows with confirmed_at NULL (expect 0)', nulls(onRows));
  out('  control: synthetic on-chain row with NULL confirmed_at (expect 1)', nulls([{ kind: 'onchain', received_at: T, confirmed_at: null }]));

  // ── check 4 ─────────────────────────────────────────────────────
  // Groups each member's on-chain credits into scans (successive received_at
  // under 120 s apart). A scan with 2+ credits is classed, never counted as an
  // anomaly by itself:
  //   one-tx      all credits share one txid (one transaction, several outputs) — legit
  //   continuous  2+ txids, sync history shows no gap > 5 min before the scan — legit
  //               (two payments confirmed together, or a repeat payment)
  //   after-gap   2+ txids, first scan after a > 5 min gap in sync history —
  //               detector catch-up after downtime OR a DB-restore replay; the
  //               database cannot tell them apart (needs LND confirmation heights)
  //   no-history  sync history has no row before the scan
  console.log('== check 4: several credits for one member in one scan ==');
  const histBefore = db.prepare('SELECT MAX(recorded_at) t FROM lnd_node_info_history WHERE recorded_at < ?');
  const scans = (rs) => {
    const t = rs.filter((r) => r.kind === 'onchain').sort((a, b) => a.received_at - b.received_at);
    const out = []; let cur = [];
    for (const r of t) { if (cur.length && r.received_at - cur[cur.length - 1].received_at >= BURST) { out.push(cur); cur = []; } cur.push(r); }
    if (cur.length) out.push(cur);
    return out.filter((s) => s.length > 1);
  };
  const scanClass = (s, prevAt) => {
    if (new Set(s.map((r) => r.txid)).size === 1) return 'one-tx';
    if (prevAt == null) return 'no-history';
    return s[0].received_at - prevAt > GAP ? 'after-gap' : 'continuous';
  };
  const cls = { 'one-tx': 0, continuous: 0, 'after-gap': 0, 'no-history': 0 }, reviewRows = [];
  members.forEach((m, i) => {
    for (const s of scans(rowsOf(m))) {
      const prev = histBefore.get(s[0].received_at - 60000).t;
      const c = scanClass(s, prev); cls[c]++;
      if (c === 'after-gap' || c === 'no-history') reviewRows.push({ ordinal: i + 1, id: h8(m.member_pubkey), class: c, credits: s.length, gap_hours: prev == null ? null : +((s[0].received_at - prev) / 3600000).toFixed(2), at: iso(s[0].received_at) });
    }
  });
  out('members examined', members.length);
  out('multi-credit scans: one-tx / continuous / AFTER-GAP / no-history', `${cls['one-tx']} / ${cls.continuous} / ${cls['after-gap']} / ${cls['no-history']}`);
  const ctl = (txids, prevGap) => scanClass(txids.map((x, k) => ({ txid: x, received_at: T + k * 1000 })), prevGap == null ? null : T - prevGap);
  out('  control: one tx, two outputs (expect one-tx)', ctl(['a', 'a'], 15000));
  out('  control: two txs, history 15 s before (expect continuous)', ctl(['a', 'b'], 15000));
  out('  control: two txs, history 3 days before (expect after-gap)', ctl(['a', 'b'], 3 * DAY));
  out('  control: grouping, 3 credits 1 s apart (expect 1 scan of 3)', scans([0, 1, 2].map((k) => ({ kind: 'onchain', txid: 't' + k, received_at: T + k * 1000 }))).map((s) => s.length).join(','));
  out('  control: grouping, 2 credits 121 s apart (expect no scan)', scans([0, 121000].map((d, k) => ({ kind: 'onchain', txid: 'u' + k, received_at: T + d }))).length);
  if (reviewRows.length) console.table(reviewRows);
  console.log('== done; nothing was written (read-only connection, query_only on) ==');
}
JS
}

main
