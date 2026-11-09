#!/usr/bin/env node
// harness-slot.test.mjs — node:test suite for scripts/harness-slot.mjs.
//
// Run the Node 20 binary by its path, not whatever `node` is first on PATH:
//   ~/.nvm/versions/node/v20.20.2/bin/node --test scripts/harness-slot.test.mjs
//
// Nothing here touches the harness: no docker, no Polar, no .env.dev.* file.
// The Polar network list is a fixture shaped like ~/.polar/networks/networks.json,
// and the home directory is fixed at /home/user so slot 1 can be compared with
// the literal scripts at 523e6ab, read from git. A git that cannot run fails the
// pin; it never passes it.
//
// No CI job runs this, and the Stop hook does not watch scripts/. Run it by hand.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertNoReserved,
  dataDir,
  envFile,
  injectedEnv,
  killPorts,
  loopserverContainer,
  parseSlot,
  resolveNetwork,
  ROLES,
  scriptCommand,
  SCRIPTS,
  slotPorts,
} from "./harness-slot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = "/home/user";
const BASE = "523e6ab";

// ─── fixtures ─────────────────────────────────────────────────────────────

const lnd = (name, grpc, rest, p2p) => ({ name, implementation: "LND", ports: { rest, grpc, p2p } });
const backend = (rpc, p2p, zmqBlock, zmqTx) =>
  ({ name: "backend1", implementation: "bitcoind", ports: { rpc, p2p, zmqBlock, zmqTx } });

// Network 1 as ubuntu-pc's networks.json has it (Phase 1 read): named
// bitcorn-dev, not bitcorn-dev-1.
const NET1 = {
  id: 1, name: "bitcorn-dev", status: 1, path: "/home/user/.polar/networks/1",
  nodes: {
    bitcoin: [backend(18444, 19445, 28335, 29336)],
    lightning: [
      lnd("Farmer1", 10004, 8084, 9738), lnd("Treasury", 10005, 8085, 9739),
      lnd("Merchant1", 10006, 8086, 9740), lnd("External-Peer-1", 10007, 8087, 9741),
    ],
  },
};
const NET2 = {
  id: 2, name: "bitcorn-dev-2", status: 1, path: "/home/user/.polar/networks/2",
  nodes: {
    bitcoin: [backend(18445, 19446, 28337, 29338)],
    lightning: [
      lnd("Farmer1", 10008, 8088, 9742), lnd("Treasury", 10009, 8089, 9743),
      lnd("Merchant1", 10010, 8090, 9744), lnd("External-Peer-1", 10011, 8091, 9745),
    ],
  },
};
const NETWORKS = { version: "3.0.0", networks: [NET1, NET2] };
const ctx = (slot, networks = NETWORKS) => ({ home: HOME, network: () => resolveNetwork(slot, networks) });
const withNode = (net, from, to) => ({
  ...net,
  nodes: { ...net.nodes, lightning: net.nodes.lightning.map((n) => (n.name === from ? { ...n, name: to } : n)) },
});

function scriptsAtBase() {
  const r = spawnSync("git", ["show", `${BASE}:package.json`], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, `git show ${BASE}:package.json could not run: ${r.error ?? r.stderr}`);
  return JSON.parse(r.stdout).scripts;
}
const scriptsNow = () => JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;

// ─── H7: slot 1 is today ──────────────────────────────────────────────────

test("H7 pin: slot 1's values are today's literal values, every row", () => {
  assert.deepEqual(slotPorts(1), {
    api: [3101, 3102, 3103],
    web: [5173, 5174, 5175],
    loopserver: 11009,
    loopdRpc: [11010, 11020, 11030],
    loopdRest: [8801, 8802, 8803],
  });
  assert.deepEqual(ROLES.map((r) => dataDir(1, r.role, HOME)), [
    "/home/user/.bitcorn-dev/treasury",
    "/home/user/.bitcorn-dev/member-a",
    "/home/user/.bitcorn-dev/member-b",
  ]);
  assert.equal(loopserverContainer(1), "bitcorn-loopserver");
  assert.deepEqual(resolveNetwork(1, NETWORKS), {
    id: 1, name: "bitcorn-dev",
    lndGrpcPort: { Farmer1: 10004, Treasury: 10005, Merchant1: 10006, "External-Peer-1": 10007 },
  });
  assert.deepEqual(ROLES.map((r) => envFile(1, r.role)), [".env.dev.treasury", ".env.dev.member-a", ".env.dev.member-b"]);
  for (const i of ROLES.keys()) assert.deepEqual(injectedEnv(1, i, ctx(1)), {}, "D15: slot 1 injects nothing");
});

test(`H8 pin: with the slot unset, every slot-1 command line is byte-identical to ${BASE}`, () => {
  const base = scriptsAtBase();
  // dev:loopserver follows H9 and dev:kill follows H11; both are pinned below.
  const pinned = SCRIPTS.filter((s) => s !== "dev:loopserver" && s !== "dev:kill");
  for (const script of pinned) {
    assert.equal(scriptCommand(script, 1, ctx(1)), base[script], `${script} differs from ${BASE}`);
  }
});

test("H8 wiring: each dev:* script runs this module under its own name, or is unchanged text", () => {
  const base = scriptsAtBase();
  const now = scriptsNow();
  assert.deepEqual(Object.keys(now), Object.keys(base), "the set of npm scripts changed");
  for (const [name, text] of Object.entries(now)) {
    if (SCRIPTS.includes(name)) assert.equal(text, `node scripts/harness-slot.mjs run ${name}`, name);
    else assert.equal(text, base[name], `${name} should be unchanged`);
  }
});

test("H8: no command passes dotenv-cli -o, which would let the env file override the slot's values", () => {
  for (const slot of [1, 2]) {
    for (const s of SCRIPTS) {
      const command = scriptCommand(s, slot, ctx(slot));
      assert.doesNotMatch(command, /\bdotenv\b[^&;|]*\s(-o|--override)\b/, `${s} slot ${slot}`);
    }
  }
});

// ─── H7: slot 2 ───────────────────────────────────────────────────────────

test("H7 slot 2: every row", () => {
  assert.deepEqual(slotPorts(2), {
    api: [3111, 3112, 3113],
    web: [5183, 5184, 5185],
    loopserver: 11109,
    loopdRpc: [11110, 11120, 11130],
    loopdRest: [8901, 8902, 8903],
  });
  assert.deepEqual(ROLES.map((r) => dataDir(2, r.role, HOME)), [
    "/home/user/.bitcorn-dev/slot-2/treasury",
    "/home/user/.bitcorn-dev/slot-2/member-a",
    "/home/user/.bitcorn-dev/slot-2/member-b",
  ]);
  assert.equal(loopserverContainer(2), "bitcorn-loopserver-2");
  assert.deepEqual(resolveNetwork(2, NETWORKS), {
    id: 2, name: "bitcorn-dev-2",
    lndGrpcPort: { Farmer1: 10008, Treasury: 10009, Merchant1: 10010, "External-Peer-1": 10011 },
  });
  assert.deepEqual(ROLES.map((r) => envFile(2, r.role)),
    [".env.dev.slot-2.treasury", ".env.dev.slot-2.member-a", ".env.dev.slot-2.member-b"]);
  assert.deepEqual(injectedEnv(2, 1, ctx(2)), {
    PORT: "3112",
    DB_DIR: "/home/user/.bitcorn-dev/slot-2/member-a/db",
    SECRETS_DIR: "/home/user/.bitcorn-dev/slot-2/member-a/secrets",
    LND_GRPC_HOST: "127.0.0.1:10008",
    LND_DIR: "/home/user/.polar/networks/2/volumes/lnd/Farmer1",
    LOOP_GRPC_PORT: "11120",
    LOOP_TLS_CERT_PATH: "/home/user/.bitcorn-dev/slot-2/member-a/loopd/regtest/tls.cert",
    LOOP_MACAROON_PATH: "/home/user/.bitcorn-dev/slot-2/member-a/loopd/regtest/loop.macaroon",
  });
});

test("H8 slot 2: the command lines carry slot 2's values", () => {
  const c = ctx(2);
  assert.equal(scriptCommand("dev:webB", 2, c),
    "cd app/web && VITE_API_BASE=http://localhost:3113 npm run dev -- --port 5185 --strictPort");
  assert.equal(scriptCommand("dev:loopd-T", 2, c),
    "~/.bitcorn-dev/loopserver/loopd --network=regtest --loopdir=/home/user/.bitcorn-dev/slot-2/treasury/loopd " +
    "--rpclisten=localhost:11110 --restlisten=localhost:8901 --lnd.host=127.0.0.1:10009 " +
    "--lnd.macaroonpath=/home/user/.polar/networks/2/volumes/lnd/Treasury/data/chain/bitcoin/regtest/admin.macaroon " +
    "--lnd.tlspath=/home/user/.polar/networks/2/volumes/lnd/Treasury/tls.cert --server.host=localhost:11109 --server.notls");
  assert.equal(scriptCommand("dev:treasury", 2, c),
    "cd app/api && PORT=3111 DB_DIR=/home/user/.bitcorn-dev/slot-2/treasury/db " +
    "SECRETS_DIR=/home/user/.bitcorn-dev/slot-2/treasury/secrets LND_GRPC_HOST=127.0.0.1:10009 " +
    "LND_DIR=/home/user/.polar/networks/2/volumes/lnd/Treasury LOOP_GRPC_PORT=11110 " +
    "LOOP_TLS_CERT_PATH=/home/user/.bitcorn-dev/slot-2/treasury/loopd/regtest/tls.cert " +
    "LOOP_MACAROON_PATH=/home/user/.bitcorn-dev/slot-2/treasury/loopd/regtest/loop.macaroon " +
    "dotenv -e ../../.env.dev.slot-2.treasury -- npm run dev");
  assert.equal(scriptCommand("dev:loopserver-stop", 2, c),
    "docker stop bitcorn-loopserver-2 2>/dev/null && echo 'loopserver stopped'");
});

// ─── H7: reserved ports ───────────────────────────────────────────────────

test("H7 reserved, through the formulas: no slot from 1 to 40 computes 3109 or 13009, and slot 21 is refused", () => {
  for (let slot = 1; slot <= 40; slot++) {
    if (slot === 21) {
      assert.throws(() => slotPorts(21), /slot 21 refused: its computed port 13009 is lnagent's tunnel port/);
      continue;
    }
    const p = slotPorts(slot);
    const all = [...p.api, ...p.web, p.loopserver, ...p.loopdRpc, ...p.loopdRest];
    assert.ok(!all.includes(3109) && !all.includes(13009), `slot ${slot}: ${all}`);
  }
});

test("H7 reserved, directly: the guard refuses 3109 and 13009 fed to it, and passes their neighbours", () => {
  assert.throws(() => assertNoReserved([3108, 3109], 5), /slot 5 refused: its computed port 3109 is the app's reserved/);
  assert.throws(() => assertNoReserved([13009], 5), /13009/);
  assert.doesNotThrow(() => assertNoReserved([3108, 3110, 13008, 13010], 5));
});

// ─── H7: the Polar network ────────────────────────────────────────────────

test("H7 network: slot 2 is refused when bitcorn-dev-2 is absent, with no fallback to network 1", () => {
  const only1 = { networks: [NET1] };
  assert.throws(() => resolveNetwork(2, only1), /slot 2: no Polar network with the name bitcorn-dev-2/);
  assert.throws(() => scriptCommand("dev:loopd-T", 2, ctx(2, only1)), /slot 2: no Polar network/);
});

test("H7 network: slot 1 resolves to id 1, named bitcorn-dev, and not to a network named bitcorn-dev-1", () => {
  const decoy = { ...NET2, id: 7, name: "bitcorn-dev-1" };
  assert.equal(resolveNetwork(1, NETWORKS).id, 1);
  assert.equal(resolveNetwork(1, { networks: [decoy, NET1] }).id, 1);
});

test("H7 D16: a network whose node names differ from the five is refused, in slot 1 and slot N", () => {
  assert.throws(() => resolveNetwork(2, { networks: [withNode(NET2, "Farmer1", "Farmer2")] }),
    /slot 2: Polar network 2 \(bitcorn-dev-2\) has nodes \[.*Farmer2.*\], not the five/);
  assert.throws(() => resolveNetwork(1, { networks: [withNode(NET1, "Merchant1", "carol")] }), /not the five/);
  const extra = { ...NET2, nodes: { ...NET2.nodes, lightning: [...NET2.nodes.lightning, lnd("dave", 1, 2, 3)] } };
  assert.throws(() => resolveNetwork(2, { networks: [extra] }), /not the five/);
});

// ─── H7, D14, D15: the env files by slot ──────────────────────────────────

test("H7 env files: slot 1 selects today's .env.dev.<role> and injects nothing; slot 2 selects .env.dev.slot-2.<role>", () => {
  for (const [i, r] of ROLES.entries()) {
    const one = scriptCommand(r.api, 1, ctx(1));
    const two = scriptCommand(r.api, 2, ctx(2));
    assert.match(one, new RegExp(`^cd app/api && dotenv -e \\.\\./\\.\\./\\.env\\.dev\\.${r.role} +-- npm run dev$`));
    assert.match(two, new RegExp(`dotenv -e \\.\\./\\.\\./\\.env\\.dev\\.slot-2\\.${r.role} -- npm run dev$`));
    assert.match(two, new RegExp(`PORT=${3111 + i} `));
  }
});

// ─── H9: loopserver ───────────────────────────────────────────────────────

test("H9 slot 1: dev:loopserver on network 1's bridge, mapped to 127.0.0.1:11009", () => {
  assert.equal(scriptCommand("dev:loopserver", 1, ctx(1)),
    "docker rm -f bitcorn-loopserver 2>/dev/null; docker run -d --name bitcorn-loopserver " +
    "--network polar-network-1_default -p 127.0.0.1:11009:11009 " +
    "-v /home/user/.polar/networks/1/volumes/lnd/External-Peer-1:/lnd:ro " +
    "lightninglabs/loopserver:v0.9.221-beta daemon --maxamt=5000000 " +
    "--lnd.host=polar-n1-External-Peer-1:10009 --lnd.macaroondir=/lnd/data/chain/bitcoin/regtest --lnd.tlspath=/lnd/tls.cert " +
    "--bitcoin.host=polar-n1-backend1:18443 --bitcoin.user=polaruser --bitcoin.password=polarpass " +
    "--bitcoin.zmqpubrawblock=tcp://polar-n1-backend1:28334 --bitcoin.zmqpubrawtx=tcp://polar-n1-backend1:28335 " +
    "&& echo 'loopserver started on 127.0.0.1:11009 — check `docker logs bitcorn-loopserver` (persists on crash)'");
});

test("H9 ZMQ: rawblock dials the container's 28334 and rawtx its 28335, never the host's 28335/29336", () => {
  for (const [slot, id] of [[1, 1], [2, 2]]) {
    const c = scriptCommand("dev:loopserver", slot, ctx(slot));
    assert.match(c, new RegExp(`--bitcoin\\.zmqpubrawblock=tcp://polar-n${id}-backend1:28334 `));
    assert.match(c, new RegExp(`--bitcoin\\.zmqpubrawtx=tcp://polar-n${id}-backend1:28335 `));
    assert.doesNotMatch(c, /29336/);
  }
});

test("H9 binding: every slot's loopserver maps only 127.0.0.1:<slot port> to 11009, on its bridge, not host networking", () => {
  for (const [slot, port, id] of [[1, 11009, 1], [2, 11109, 2]]) {
    const c = scriptCommand("dev:loopserver", slot, ctx(slot));
    const mappings = c.match(/ -p \S+/g);
    assert.deepEqual(mappings, [` -p 127.0.0.1:${port}:11009`], `slot ${slot}`);
    assert.match(c, new RegExp(`--network polar-network-${id}_default `));
    assert.doesNotMatch(c, /--network host|:1100\b/);
  }
});

// ─── H11: dev:kill ────────────────────────────────────────────────────────

test("H11: slot 1's and slot 2's kill lists do not overlap, carry the loopd REST ports, and no loopserver port", () => {
  const one = killPorts(1);
  const two = killPorts(2);
  console.log(`slot 1 kill list: ${one}\nslot 2 kill list: ${two}`);
  assert.deepEqual(one.filter((p) => two.includes(p)), [], "overlap");
  for (const [list, rest] of [[one, [8801, 8802, 8803]], [two, [8901, 8902, 8903]]]) {
    for (const p of rest) assert.ok(list.includes(p), `REST ${p}`);
    for (const p of [11009, 11109]) assert.ok(!list.includes(p), `loopserver ${p}`);
  }
});

test("H11: dev:kill's kill and --print command lines for slot 1", () => {
  const ports = "3101,3102,3103,5173,5174,5175,11010,11020,11030,8801,8802,8803";
  assert.equal(scriptCommand("dev:kill", 1, ctx(1)),
    `lsof -ti:${ports} | xargs -r kill -9 2>/dev/null; ` +
    "echo 'dev ports cleared (incl loopd; stop loopserver with npm run dev:loopserver-stop)'");
  assert.equal(scriptCommand("dev:kill", 1, ctx(1), ["--print"]), `lsof -ti:${ports} || echo 'no process on slot 1 ports'`);
  assert.doesNotMatch(scriptCommand("dev:kill", 1, ctx(1), ["--print"]), /kill/);
  assert.throws(() => scriptCommand("dev:kill", 1, ctx(1), ["--all"]), /dev:kill takes only --print/);
});

// ─── the slot and the shell ───────────────────────────────────────────────

test("HARNESS_SLOT: unset is 1; a whole number from 1 is taken; anything else is refused", () => {
  assert.equal(parseSlot(undefined), 1);
  assert.equal(parseSlot("2"), 2);
  for (const bad of ["", "0", "-1", "abc", "2.5", " 2"]) assert.throws(() => parseSlot(bad), /HARNESS_SLOT/, bad);
});

test("shell text: a home directory the command lines would have to quote is refused", () => {
  assert.throws(() => dataDir(1, "treasury", "/home/a b"), /do not quote/);
  assert.equal(scriptCommand("dev:webT", 1, ctx(1), ["--open", "a b"]),
    "cd app/web && VITE_API_BASE=http://localhost:3101 npm run dev -- --port 5173 --strictPort --open 'a b'");
});

test("cli: command prints the resolved line and run is refused for an unknown script", () => {
  const script = path.join(ROOT, "scripts", "harness-slot.mjs");
  const env = { ...process.env, HARNESS_SLOT: "1" };
  const printed = spawnSync(process.execPath, [script, "command", "dev:webA"], { encoding: "utf8", env });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, "cd app/web && VITE_API_BASE=http://localhost:3102 npm run dev -- --port 5174 --strictPort\n");
  const unknown = spawnSync(process.execPath, [script, "run", "dev:nope"], { encoding: "utf8", env });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /no slot command for "dev:nope"/);
  const bad = spawnSync(process.execPath, [script, "command", "dev:webA"], { encoding: "utf8", env: { ...env, HARNESS_SLOT: "x" } });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /HARNESS_SLOT must be/);
});

test("(h) running under the Node major pinned in .nvmrc", () => {
  const pinned = fs.readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim();
  assert.equal(process.versions.node.split(".")[0], pinned);
  console.log(`process.version ${process.version}`);
});
