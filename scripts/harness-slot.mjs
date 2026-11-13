#!/usr/bin/env node
// harness-slot.mjs — the dev harness's slot-dependent values, computed from a
// slot number, and the dev:* npm scripts' command lines built from them.
//
// Run:  node scripts/harness-slot.mjs command <npm-script>   print the resolved command line
//       node scripts/harness-slot.mjs run <npm-script> [args]  run it under sh
//       node scripts/harness-slot.mjs lock acquire|release|status ...   the slot locks (H14)
// The root package.json's dev:* scripts call `run`. The slot comes from
// HARNESS_SLOT, default 1.
//
// THE LOCK (H14, D11): `run` refuses every script unless the slot's lock,
// ~/.bitcorn-dev/locks/slot-N.lock, exists and its holder equals
// HARNESS_HOLDER, and refuses while setup.lock is held. The refusal names the
// holder, or "no lock". Read-only needs no lock: `command`, `lock status` and
// dev:kill --print. scripts/polar-preflight.mjs enforces the same lock.
//
// SLOT 1 IS TODAY'S HARNESS (D6). Its command lines are byte-identical to the
// scripts at 523e6ab, except dev:loopserver (D13: the bridge network, bound to
// 127.0.0.1) and dev:kill (H11: no loopserver port, the loopd REST ports added,
// a --print mode; H15: listening sockets only) and the API lines, which carry
// API_LISTEN_HOST=127.0.0.1 (dev-safety R2, superseding D15 for that one
// value). Slot 1 injects nothing else: today's .env.dev.<role> files stay
// authoritative for every other value.
//
// SLOT N (N >= 2), per D8:
//   API ports        3101-3103 + 10(N-1)     web ports   5173-5175 + 10(N-1)
//   loopserver       11009 + 100(N-1)        loopd RPC   11010/11020/11030 + 100(N-1)
//   loopd REST       8801-8803 + 100(N-1)
//   data dirs        ~/.bitcorn-dev/slot-N/<role>
//   loopserver name  bitcorn-loopserver-N
//   Polar network    the one named bitcorn-dev-N in ~/.polar/networks/networks.json;
//                    absent is an error, never a fallback to network 1
//   API env files    .env.dev.slot-N.<role> (D14: slot N's identity), with the
//                    computed values above, BITCOIN_NETWORK=regtest,
//                    LOOP_GRPC_HOST=127.0.0.1 and API_LISTEN_HOST=127.0.0.1
//                    injected over them (D7; R2). dotenv-cli
//                    does not override a variable already set, so the injected
//                    values win; the scripts must never pass it -o.
//
// Refused: a computed port equal to a reserved one (3109, 13009), so slot 21 is
// an error; a Polar network whose node names are not D16's five.
//
// Spec (vault): specs/2026-11-09-harness-host-b2-slot-implementation-spec.md,
// H7 to H12, H14 (the lock) and H15 (dev:kill, listeners only).
// Tests: scripts/harness-slot.test.mjs, run by hand under Node 20.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RESERVED_PORTS = new Map([
  [3109, "the app's reserved node-to-node port"],
  [13009, "lnagent's tunnel port"],
]);

// D16: every slot's Polar network has exactly these nodes.
export const BITCOIN_NODE = "backend1";
export const LND_NODE_NAMES = ["Treasury", "Merchant1", "Farmer1", "External-Peer-1"];

export const ROLES = [
  { role: "treasury", key: "T", node: "Treasury", api: "dev:treasury" },
  { role: "member-a", key: "A", node: "Farmer1", api: "dev:memberA" },
  { role: "member-b", key: "B", node: "Merchant1", api: "dev:memberB" },
];

// ─── the slot and its values ──────────────────────────────────────────────

export function parseSlot(raw) {
  if (raw === undefined) return 1;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`HARNESS_SLOT must be a whole number from 1, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

export function assertNoReserved(ports, slot) {
  for (const port of ports) {
    if (RESERVED_PORTS.has(port)) {
      throw new Error(`slot ${slot} refused: its computed port ${port} is ${RESERVED_PORTS.get(port)}`);
    }
  }
}

export function slotPorts(slot) {
  const k = slot - 1;
  const ports = {
    api: [3101, 3102, 3103].map((p) => p + 10 * k),
    web: [5173, 5174, 5175].map((p) => p + 10 * k),
    loopserver: 11009 + 100 * k,
    loopdRpc: [11010, 11020, 11030].map((p) => p + 100 * k),
    loopdRest: [8801, 8802, 8803].map((p) => p + 100 * k),
  };
  assertNoReserved([...ports.api, ...ports.web, ports.loopserver, ...ports.loopdRpc, ...ports.loopdRest], slot);
  return ports;
}

// The command lines are shell text, so a home directory outside this set is
// refused rather than quoted: quoting would change slot 1's text.
function checkHome(home) {
  if (!/^\/[A-Za-z0-9._\/-]*$/.test(home)) {
    throw new Error(`home directory ${JSON.stringify(home)} has characters these command lines do not quote`);
  }
  return home;
}

export const dataDir = (slot, role, home) =>
  slot === 1 ? `${checkHome(home)}/.bitcorn-dev/${role}` : `${checkHome(home)}/.bitcorn-dev/slot-${slot}/${role}`;

export const loopserverContainer = (slot) => (slot === 1 ? "bitcorn-loopserver" : `bitcorn-loopserver-${slot}`);

export const envFile = (slot, role) => (slot === 1 ? `.env.dev.${role}` : `.env.dev.slot-${slot}.${role}`);

// Slot 1 resolves by id 1 (named bitcorn-dev, not bitcorn-dev-1); slot N by the
// name bitcorn-dev-N. Either way the node names must be D16's five.
export function resolveNetwork(slot, networksJson) {
  const networks = networksJson?.networks;
  if (!Array.isArray(networks)) throw new Error("networks.json has no networks array");
  const wanted = slot === 1 ? "id 1" : `the name bitcorn-dev-${slot}`;
  const matches = networks.filter((n) => (slot === 1 ? n.id === 1 : n.name === `bitcorn-dev-${slot}`));
  if (matches.length === 0) throw new Error(`slot ${slot}: no Polar network with ${wanted} in networks.json`);
  if (matches.length > 1) throw new Error(`slot ${slot}: ${matches.length} Polar networks with ${wanted}`);
  const network = matches[0];

  const nodes = network.nodes ?? {};
  const all = Object.values(nodes).flat().map((n) => n?.name).sort();
  const bitcoin = (nodes.bitcoin ?? []).map((n) => n?.name);
  const expected = [BITCOIN_NODE, ...LND_NODE_NAMES].sort();
  if (JSON.stringify(all) !== JSON.stringify(expected) || !bitcoin.includes(BITCOIN_NODE)) {
    throw new Error(
      `slot ${slot}: Polar network ${network.id} (${network.name}) has nodes [${all}], ` +
      `not the five every slot uses [${expected}]`,
    );
  }

  const lndGrpcPort = {};
  for (const node of nodes.lightning ?? []) {
    if (!Number.isInteger(node.ports?.grpc)) {
      throw new Error(`slot ${slot}: networks.json gives ${node.name} no integer grpc port`);
    }
    lndGrpcPort[node.name] = node.ports.grpc;
  }
  if (!Number.isInteger(network.id)) throw new Error(`slot ${slot}: networks.json gives no integer network id`);
  return { id: network.id, name: network.name, lndGrpcPort };
}

const lndVolume = (home, networkId, node) => `${checkHome(home)}/.polar/networks/${networkId}/volumes/lnd/${node}`;

// Slot N's files hold identity only (D14), so the two settings a dev API cannot
// do without, and whose API defaults are production values, are injected too
// (Ethan's ruling, option (b), 2026-11-09). Slot 1 gets them from its own files.
export const SLOT_N_SETTINGS = { BITCOIN_NETWORK: "regtest", LOOP_GRPC_HOST: "127.0.0.1" };

// dev-safety R2 (vault: decisions/2026-11-13-dev-safety-rulings-r1-to-r5-…):
// every slot's API binds loopback only. The API reads it in ports.ts; unset
// there means production's bind, so the harness is its single statement.
export const ALL_SLOT_SETTINGS = { API_LISTEN_HOST: "127.0.0.1" };

// Slot 1: ALL_SLOT_SETTINGS only (R2 supersedes D15 for that value). Slot N:
// its computed values, SLOT_N_SETTINGS and ALL_SLOT_SETTINGS, over its own files.
export function injectedEnv(slot, roleIndex, ctx) {
  if (slot === 1) return { ...ALL_SLOT_SETTINGS };
  const { role, node } = ROLES[roleIndex];
  const ports = slotPorts(slot);
  const network = ctx.network();
  const dir = dataDir(slot, role, ctx.home);
  return {
    PORT: String(ports.api[roleIndex]),
    DB_DIR: `${dir}/db`,
    SECRETS_DIR: `${dir}/secrets`,
    LND_GRPC_HOST: `127.0.0.1:${network.lndGrpcPort[node]}`,
    LND_DIR: lndVolume(ctx.home, network.id, node),
    LOOP_GRPC_PORT: String(ports.loopdRpc[roleIndex]),
    LOOP_TLS_CERT_PATH: `${dir}/loopd/regtest/tls.cert`,
    LOOP_MACAROON_PATH: `${dir}/loopd/regtest/loop.macaroon`,
    ...SLOT_N_SETTINGS,
    ...ALL_SLOT_SETTINGS,
  };
}

// ─── the command lines ────────────────────────────────────────────────────

// Slot 1's member lines carry two spaces before `--`, as they did at 523e6ab.
const API_GAP = { treasury: " ", "member-a": "  ", "member-b": "  " };

function apiCommand(slot, roleIndex, ctx) {
  const { role } = ROLES[roleIndex];
  const assignments = Object.entries(injectedEnv(slot, roleIndex, ctx)).map(([k, v]) => `${k}=${v} `).join("");
  const gap = slot === 1 ? API_GAP[role] : " ";
  return `cd app/api && ${assignments}dotenv -e ../../${envFile(slot, role)}${gap}-- npm run dev`;
}

function webCommand(slot, roleIndex) {
  const ports = slotPorts(slot);
  return `cd app/web && VITE_API_BASE=http://localhost:${ports.api[roleIndex]} npm run dev -- --port ${ports.web[roleIndex]} --strictPort`;
}

function loopdCommand(slot, roleIndex, ctx) {
  const { role, node } = ROLES[roleIndex];
  const ports = slotPorts(slot);
  const network = ctx.network();
  const lnd = lndVolume(ctx.home, network.id, node);
  return [
    "~/.bitcorn-dev/loopserver/loopd --network=regtest",
    `--loopdir=${dataDir(slot, role, ctx.home)}/loopd`,
    `--rpclisten=localhost:${ports.loopdRpc[roleIndex]}`,
    `--restlisten=localhost:${ports.loopdRest[roleIndex]}`,
    `--lnd.host=127.0.0.1:${network.lndGrpcPort[node]}`,
    `--lnd.macaroonpath=${lnd}/data/chain/bitcoin/regtest/admin.macaroon`,
    `--lnd.tlspath=${lnd}/tls.cert`,
    `--server.host=localhost:${ports.loopserver}`,
    "--server.notls",
  ].join(" ");
}

// D9, D12, D13: every slot's loopserver on its Polar network's bridge, RPC
// mapped to 127.0.0.1 only, dialing LND and bitcoind by container name at the
// CONTAINER's ports. ZMQ: rawblock is 28334 and rawtx 28335 inside the
// container (28335 and 29336 on the host), so the host numbers must not be
// carried over. The status port (1100) is not mapped.
function loopserverCommand(slot, ctx) {
  const network = ctx.network();
  const name = loopserverContainer(slot);
  const port = slotPorts(slot).loopserver;
  const n = `polar-n${network.id}-`;
  return [
    `docker rm -f ${name} 2>/dev/null;`,
    `docker run -d --name ${name}`,
    `--network polar-network-${network.id}_default`,
    `-p 127.0.0.1:${port}:11009`,
    `-v ${lndVolume(ctx.home, network.id, "External-Peer-1")}:/lnd:ro`,
    "lightninglabs/loopserver:v0.9.221-beta daemon --maxamt=5000000",
    `--lnd.host=${n}External-Peer-1:10009`,
    "--lnd.macaroondir=/lnd/data/chain/bitcoin/regtest --lnd.tlspath=/lnd/tls.cert",
    `--bitcoin.host=${n}backend1:18443`,
    "--bitcoin.user=polaruser --bitcoin.password=polarpass",
    `--bitcoin.zmqpubrawblock=tcp://${n}backend1:28334`,
    `--bitcoin.zmqpubrawtx=tcp://${n}backend1:28335`,
    `&& echo 'loopserver started on 127.0.0.1:${port} — check \`docker logs ${name}\` (persists on crash)'`,
  ].join(" ");
}

const loopserverStopCommand = (slot) =>
  `docker stop ${loopserverContainer(slot)} 2>/dev/null && echo 'loopserver stopped'`;

// H11: the slot's API, web, loopd RPC and loopd REST ports. Not loopserver's:
// under D13 its port is held by Docker's root-owned proxy, which this cannot
// see or kill; dev:loopserver-stop stops it.
export function killPorts(slot) {
  const p = slotPorts(slot);
  return [...p.api, ...p.web, ...p.loopdRpc, ...p.loopdRest];
}

// H15: listening sockets only. `lsof -i:<port>` also matches a connection whose
// REMOTE end is that port (a browser holding a connection to another host's
// 3101, say), and dev:kill would kill -9 it. -sTCP:LISTEN keeps only listeners.
// --print uses the same selection, so it lists exactly what a real run kills.
const listenerPids = (ports) => `lsof -t -nP -iTCP:${ports} -sTCP:LISTEN`;

function killCommand(slot, print) {
  const ports = killPorts(slot).join(",");
  if (print) return `${listenerPids(ports)} || echo 'no listener on slot ${slot} ports'`;
  return `${listenerPids(ports)} | xargs -r kill -9 2>/dev/null; ` +
    "echo 'dev ports cleared (incl loopd; stop loopserver with npm run dev:loopserver-stop)'";
}

export const SCRIPTS = [
  "dev:treasury", "dev:memberA", "dev:memberB",
  "dev:webT", "dev:webA", "dev:webB",
  "dev:kill",
  "dev:loopserver", "dev:loopd-T", "dev:loopd-A", "dev:loopd-B",
  "dev:loopserver-stop",
];

const quote = (arg) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

// The script name and dev:kill's arguments, checked before anything else
// (main checks them before the lock, so an unknown script is named as such).
export function checkScript(script, args = []) {
  if (!SCRIPTS.includes(script)) throw new Error(`no slot command for ${JSON.stringify(script)}; known: ${SCRIPTS.join(" ")}`);
  if (script === "dev:kill") {
    const unknown = args.filter((a) => a !== "--print");
    if (unknown.length > 0) throw new Error(`dev:kill takes only --print, got ${unknown.join(" ")}`);
  }
}

// Read-only, so they need no lock (H14): printing a command line (the `command`
// subcommand) and dev:kill --print. Everything else `run` starts, stops or kills.
export const isReadOnlyRun = (script, args = []) => script === "dev:kill" && args.includes("--print");

// ctx: { home, network() } — network() resolves lazily, so the scripts that
// need no Polar network (web, kill, stop, slot 1's API) never read networks.json.
export function scriptCommand(script, slot, ctx, args = []) {
  checkScript(script, args);
  const roleIndex = ROLES.findIndex((r) => r.api === script || `dev:web${r.key}` === script || `dev:loopd-${r.key}` === script);
  let command;
  if (script === "dev:kill") {
    return killCommand(slot, args.includes("--print"));
  } else if (script === "dev:loopserver") command = loopserverCommand(slot, ctx);
  else if (script === "dev:loopserver-stop") command = loopserverStopCommand(slot);
  else if (script.startsWith("dev:web") && roleIndex >= 0) command = webCommand(slot, roleIndex);
  else if (script.startsWith("dev:loopd-") && roleIndex >= 0) command = loopdCommand(slot, roleIndex, ctx);
  else if (roleIndex >= 0) command = apiCommand(slot, roleIndex, ctx);
  else throw new Error(`no slot command for ${JSON.stringify(script)}; known: ${SCRIPTS.join(" ")}`);
  // Extra npm arguments land at the end, as they did when the script was literal text.
  return args.length > 0 ? `${command} ${args.map(quote).join(" ")}` : command;
}

// ─── the lock (H14, D11) ──────────────────────────────────────────────────
//
// One lock per slot, ~/.bitcorn-dev/locks/slot-N.lock, and one host-wide lock
// for Polar setup windows, setup.lock. A lock file is created with an exclusive
// create, so a second acquire fails. It holds holder, go, acquired_at (UTC),
// host and the slot number or "setup". The go is a claim: the lock records what
// the acquirer typed and cannot verify it (D11b). Every acquire, release and
// forced release appends one line to history.log. A setup lock and a slot lock
// never coexist: each acquire checks for the other kind before and after its
// own create, and backs out if one appeared in between.

export const lockDir = (home) => path.join(home, ".bitcorn-dev", "locks");
const lockFile = (home, target) => path.join(lockDir(home), target === "setup" ? "setup.lock" : `slot-${target}.lock`);
const historyFile = (home) => path.join(lockDir(home), "history.log");
const lockName = (target) => (target === "setup" ? "setup" : `slot ${target}`);
const utc = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

// null when there is no lock; { unreadable: true } when the file does not parse.
export function readLock(home, target) {
  let text;
  try {
    text = fs.readFileSync(lockFile(home, target), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const lock = JSON.parse(text);
    if (typeof lock?.holder === "string") return lock;
  } catch {}
  return { unreadable: true, holder: "(unreadable lock file)" };
}

function heldSlots(home) {
  let names;
  try {
    names = fs.readdirSync(lockDir(home));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names.map((n) => n.match(/^slot-([1-9][0-9]*)\.lock$/)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
}

// The other kind of lock that stands in the way of acquiring `target`, or null.
function exclusionConflict(home, target) {
  if (target === "setup") {
    const slots = heldSlots(home);
    return slots.length === 0 ? null :
      `setup refused: slot locks are held (${slots.map((s) => `slot ${s} by ${JSON.stringify(readLock(home, s)?.holder)}`).join(", ")})`;
  }
  const setup = readLock(home, "setup");
  return setup === null ? null : `slot ${target} refused: setup.lock is held by ${JSON.stringify(setup.holder)}`;
}

function requireText(flag, value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${flag} must be given and not empty`);
  return value;
}

function appendHistory(home, line) {
  fs.appendFileSync(historyFile(home), `${line}\n`);
}

const field = (k, v) => `${k}=${JSON.stringify(v)}`;

function heldFor(from, to) {
  const minutes = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  return Number.isNaN(minutes) ? "?" : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function acquireLock({ home, target, holder, go, now = new Date(), host = os.hostname() }) {
  requireText("--holder", holder);
  requireText("--go", go);
  const before = exclusionConflict(home, target);
  if (before) throw new Error(before);
  fs.mkdirSync(lockDir(home), { recursive: true });
  const lock = { holder, go, acquired_at: utc(now), host, slot: target };
  try {
    fs.writeFileSync(lockFile(home, target), `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const held = readLock(home, target);
    throw new Error(`${lockName(target)} is already locked by ${JSON.stringify(held?.holder)}` +
      (held?.acquired_at ? ` since ${held.acquired_at}, go ${JSON.stringify(held.go)}` : ""));
  }
  const after = exclusionConflict(home, target);
  if (after) {
    fs.unlinkSync(lockFile(home, target));
    throw new Error(after);
  }
  appendHistory(home, `${utc(now)} acquire ${field("lock", lockName(target))} ${field("holder", holder)} ${field("go", go)} ${field("host", host)}`);
  return `acquired ${lockName(target)} for ${holder}: ${lockFile(home, target)}`;
}

export function releaseLock({ home, target, holder, now = new Date() }) {
  requireText("--holder", holder);
  const lock = readLock(home, target);
  if (lock === null) throw new Error(`${lockName(target)}: no lock to release`);
  if (lock.holder !== holder) {
    throw new Error(`${lockName(target)} is held by ${JSON.stringify(lock.holder)}, not ${JSON.stringify(holder)}; ` +
      "a stale lock is cleared with lock release --force --reason \"<why>\"");
  }
  fs.unlinkSync(lockFile(home, target));
  const at = utc(now);
  appendHistory(home, `${at} release ${field("lock", lockName(target))} ${field("holder", holder)} ` +
    `${field("acquired_at", lock.acquired_at)} ${field("held", heldFor(lock.acquired_at, at))}`);
  return `harness lock released: ${lockName(target)}, holder ${holder}, held ${lock.acquired_at} to ${at} ` +
    `(${heldFor(lock.acquired_at, at)}) on ${lock.host}; go ${JSON.stringify(lock.go)}`;
}

export function forceReleaseLock({ home, target, reason, now = new Date() }) {
  requireText("--reason", reason);
  const lock = readLock(home, target);
  if (lock === null) throw new Error(`${lockName(target)}: no lock to release`);
  fs.unlinkSync(lockFile(home, target));
  const at = utc(now);
  appendHistory(home, `${at} force-release ${field("lock", lockName(target))} ${field("holder", lock.holder)} ` +
    `${field("acquired_at", lock.acquired_at ?? null)} ${field("reason", reason)}`);
  return `harness lock FORCE-released: ${lockName(target)}, was held by ${lock.holder} since ${lock.acquired_at ?? "?"}; ` +
    `reason ${JSON.stringify(reason)}`;
}

export function lockStatus(home) {
  const lines = [];
  for (const target of ["setup", ...heldSlots(home)]) {
    const lock = readLock(home, target);
    if (lock === null) continue;
    lines.push(lock.unreadable ? `${lockName(target)}: lock file unreadable (${lockFile(home, target)})` :
      `${lockName(target)}: held by ${lock.holder} since ${lock.acquired_at} on ${lock.host}; go ${JSON.stringify(lock.go)}`);
  }
  return lines.length > 0 ? lines.join("\n") : "no locks held";
}

// Enforcement (D11a): null when HARNESS_HOLDER holds the slot's lock, else the
// refusal, naming the current holder or "no lock".
export function lockRefusal(slot, harnessHolder, home) {
  const setup = readLock(home, "setup");
  if (setup !== null) return `slot ${slot} refused: setup.lock is held by ${JSON.stringify(setup.holder)} (a Polar setup window)`;
  const lock = readLock(home, slot);
  if (lock === null) {
    return `slot ${slot} refused: no lock. Acquire it first: node scripts/harness-slot.mjs lock acquire ` +
      `--slot ${slot} --holder <arc> --go "<who gave the go>", then set HARNESS_HOLDER=<arc>`;
  }
  if (!harnessHolder) return `slot ${slot} refused: locked by ${JSON.stringify(lock.holder)}, and HARNESS_HOLDER is unset`;
  if (harnessHolder !== lock.holder) {
    return `slot ${slot} refused: locked by ${JSON.stringify(lock.holder)}, not HARNESS_HOLDER ${JSON.stringify(harnessHolder)}`;
  }
  return null;
}

const LOCK_USAGE =
  "usage: harness-slot.mjs lock acquire (--slot N | --setup) --holder <arc> --go \"<text>\"\n" +
  "       harness-slot.mjs lock release (--slot N | --setup) --holder <arc>\n" +
  "       harness-slot.mjs lock release (--slot N | --setup) --force --reason \"<text>\"\n" +
  "       harness-slot.mjs lock status";

function parseLockArgs(args) {
  const opts = {};
  const valued = { "--slot": "slot", "--holder": "holder", "--go": "go", "--reason": "reason" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg in valued) {
      if (i + 1 >= args.length) throw new Error(`${arg} needs a value`);
      opts[valued[arg]] = args[++i];
    } else if (arg === "--setup" || arg === "--force") {
      opts[arg.slice(2)] = true;
    } else {
      throw new Error(`unknown lock argument ${JSON.stringify(arg)}`);
    }
  }
  return opts;
}

function lockTarget(opts) {
  if ((opts.slot !== undefined) === Boolean(opts.setup)) throw new Error("give exactly one of --slot N or --setup");
  if (opts.setup) return "setup";
  if (!/^[1-9][0-9]*$/.test(opts.slot)) throw new Error(`--slot must be a whole number from 1, got ${JSON.stringify(opts.slot)}`);
  return Number(opts.slot);
}

export function lockMain(args, { home = os.homedir(), now = new Date(), host = os.hostname() } = {}) {
  const [action, ...rest] = args;
  const opts = parseLockArgs(rest);
  if (action === "status") {
    if (Object.keys(opts).length > 0) throw new Error("lock status takes no arguments");
    return lockStatus(home);
  }
  if (action === "acquire") {
    if (opts.force || opts.reason !== undefined) throw new Error("--force and --reason belong to lock release");
    return acquireLock({ home, target: lockTarget(opts), holder: opts.holder, go: opts.go, now, host });
  }
  if (action === "release") {
    if (opts.go !== undefined) throw new Error("--go belongs to lock acquire");
    const target = lockTarget(opts);
    if (opts.force) return forceReleaseLock({ home, target, reason: opts.reason, now });
    if (opts.reason !== undefined) throw new Error("--reason needs --force");
    return releaseLock({ home, target, holder: opts.holder, now });
  }
  throw new Error(LOCK_USAGE);
}

// ─── entry point ──────────────────────────────────────────────────────────

export function liveContext(slot, home = os.homedir()) {
  let cached;
  const file = path.join(home, ".polar", "networks", "networks.json");
  return {
    home,
    network: () => (cached ??= resolveNetwork(slot, JSON.parse(fs.readFileSync(file, "utf8")))),
  };
}

function spawnShell(command) {
  const child = spawn("sh", ["-c", command], { cwd: ROOT, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => {
    if (!signal) process.exit(code ?? 1);
    process.removeAllListeners(signal); // so the re-raised signal terminates this process
    process.kill(process.pid, signal);
  });
  return null;
}

// Returns an exit code, or null once `run` has handed over to the shell.
export function main(argv, env, { home = os.homedir(), shell = spawnShell, out = console.log, err = console.error } = {}) {
  const [sub, ...rest] = argv;
  if (sub === "lock") {
    try {
      out(lockMain(rest, { home }));
      return 0;
    } catch (error) {
      err(`harness-slot lock: ${error.message}`);
      return 2;
    }
  }
  if (sub !== "command" && sub !== "run") {
    err("usage: harness-slot.mjs command|run <npm-script> [args]\n       harness-slot.mjs lock acquire|release|status ...");
    return 2;
  }
  const [script, ...args] = rest;
  let command;
  try {
    const slot = parseSlot(env.HARNESS_SLOT);
    checkScript(script, args);
    // H14 enforcement, before the command is even built.
    if (sub === "run" && !isReadOnlyRun(script, args)) {
      const refusal = lockRefusal(slot, env.HARNESS_HOLDER, home);
      if (refusal) throw new Error(refusal);
    }
    command = scriptCommand(script, slot, liveContext(slot, home), args);
  } catch (error) {
    err(`harness-slot: ${error.message}`);
    return 2;
  }
  if (sub === "command") {
    out(command);
    return 0;
  }
  return shell(command);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = main(process.argv.slice(2), process.env);
  if (code !== null) process.exit(code);
}
