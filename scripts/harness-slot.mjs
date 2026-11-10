#!/usr/bin/env node
// harness-slot.mjs — the dev harness's slot-dependent values, computed from a
// slot number, and the dev:* npm scripts' command lines built from them.
//
// Run:  node scripts/harness-slot.mjs command <npm-script>   print the resolved command line
//       node scripts/harness-slot.mjs run <npm-script> [args]  run it under sh
// The root package.json's dev:* scripts call `run`. The slot comes from
// HARNESS_SLOT, default 1.
//
// SLOT 1 IS TODAY'S HARNESS (D6). Its command lines are byte-identical to the
// scripts at 523e6ab, except dev:loopserver (D13: the bridge network, bound to
// 127.0.0.1) and dev:kill (H11: no loopserver port, the loopd REST ports added,
// a --print mode). Slot 1 injects no environment (D15): today's .env.dev.<role>
// files stay authoritative.
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
//                    computed values above, BITCOIN_NETWORK=regtest and
//                    LOOP_GRPC_HOST=127.0.0.1 injected over them (D7). dotenv-cli
//                    does not override a variable already set, so the injected
//                    values win; the scripts must never pass it -o.
//
// Refused: a computed port equal to a reserved one (3109, 13009), so slot 21 is
// an error; a Polar network whose node names are not D16's five.
//
// Spec (vault): specs/2026-11-09-harness-host-b2-slot-implementation-spec.md,
// H7 to H12. Tests: scripts/harness-slot.test.mjs, run by hand under Node 20.

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

// D15: slot 1 injects nothing. Slot N: its computed values and SLOT_N_SETTINGS,
// over its own files.
export function injectedEnv(slot, roleIndex, ctx) {
  if (slot === 1) return {};
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

function killCommand(slot, print) {
  const ports = killPorts(slot).join(",");
  if (print) return `lsof -ti:${ports} || echo 'no process on slot ${slot} ports'`;
  return `lsof -ti:${ports} | xargs -r kill -9 2>/dev/null; ` +
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

// ctx: { home, network() } — network() resolves lazily, so the scripts that
// need no Polar network (web, kill, stop, slot 1's API) never read networks.json.
export function scriptCommand(script, slot, ctx, args = []) {
  const roleIndex = ROLES.findIndex((r) => r.api === script || `dev:web${r.key}` === script || `dev:loopd-${r.key}` === script);
  let command;
  if (script === "dev:kill") {
    const unknown = args.filter((a) => a !== "--print");
    if (unknown.length > 0) throw new Error(`dev:kill takes only --print, got ${unknown.join(" ")}`);
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

// ─── entry point ──────────────────────────────────────────────────────────

export function liveContext(slot, home = os.homedir()) {
  let cached;
  const file = path.join(home, ".polar", "networks", "networks.json");
  return {
    home,
    network: () => (cached ??= resolveNetwork(slot, JSON.parse(fs.readFileSync(file, "utf8")))),
  };
}

function main(argv, env) {
  const [sub, script, ...args] = argv;
  if (sub !== "command" && sub !== "run") {
    console.error("usage: harness-slot.mjs command|run <npm-script> [args]");
    return 2;
  }
  let command;
  try {
    const slot = parseSlot(env.HARNESS_SLOT);
    command = scriptCommand(script, slot, liveContext(slot), args);
  } catch (error) {
    console.error(`harness-slot: ${error.message}`);
    return 2;
  }
  if (sub === "command") {
    console.log(command);
    return 0;
  }
  const child = spawn("sh", ["-c", command], { cwd: ROOT, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => {
    if (!signal) process.exit(code ?? 1);
    process.removeAllListeners(signal); // so the re-raised signal terminates this process
    process.kill(process.pid, signal);
  });
  return null;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = main(process.argv.slice(2), process.env);
  if (code !== null) process.exit(code);
}
