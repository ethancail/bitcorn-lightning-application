// COVERAGE: every dispatch site that can move capital is classified.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS IS AN AST WALK AND NOT A LIST COMPARISON
//
// A test that compares two hand-maintained lists is WORSE THAN NO TEST: it has
// the shape of a mechanism while being an instruction to remember, and it goes
// green for a route nobody classified as readily as for one they did. So the
// capital set here is DERIVED — from index.ts's dispatch chain, through the
// route modules, to the primitives that actually move funds — and compared
// against the table in action-confirmation.ts. The table is the thing under
// test, not the source of truth.
//
// The line/regex version of this walk was built first and DISCARDED, because
// three controls broke it:
//   · dropping dynamic-import handling silently lost /api/subscription/
//     pay-from-node, which reaches sendLndToChainAddress through
//     `const { … } = await import("../lightning/lnd")` — a live on-chain path
//   · `const _send = payInvoice; await _send(…)` silently lost /api/pay
//   · a COMMENT mentioning `payInvoice(` promoted /api/contacts, a pure DB
//     write, into the capital set
// The TypeScript checker resolves the first two and cannot see the third,
// because comments are not AST nodes.
//
// ═══════════════════════════════════════════════════════════════════════════
// DERIVE OR REFUSE — the property that makes this sound
//
// Reachability from a seed is only decidable where every callee resolves. This
// walk therefore records EVERY call it cannot resolve and fails on any that is
// not a recognised benign shape, rather than quietly omitting it. A silent
// under-report is the one failure this test exists to prevent, so it is the
// one failure it must not be capable of.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IT STILL DOES NOT CATCH — stated, not implied
//
// 1. A NEW OUTFLOW PRIMITIVE outside OUTFLOW_PRIMITIVES. Every reachability
//    analysis needs a seed and the seed is written by hand. This is the real
//    hole, and `egress containment` below is what narrows it: fund-moving
//    ln-service calls are confined to two files, and that confinement is
//    asserted. It does NOT cover a brand-new egress channel (a second HTTP
//    exchange client, say) — that would need adding here deliberately.
// 2. Dynamic dispatch through `any` introduced above the primitive boundary.
//    It fails the test loudly (good) but cannot be classified automatically;
//    a human has to resolve it.
// 3. Anything reached from a scheduler rather than a request. Those paths have
//    no caller and no parameter, so confirmation cannot apply to them at all —
//    they belong to the capital-guardrail arc.
//
// ── NAMED, NOT NUMBERED, from here down ────────────────────────────────────
// Entries below are named, and new ones must be too. An ordinal is a stored
// count: "the fourth" stops being true the moment this list changes, and two
// different holes have already been recorded elsewhere under that same label.
// The three above keep their numbers — renumbering settled text is its own rot.
//
// ── THE LIMIT-CONFIGURATION BLIND SPOT — DECIDED, not a gap ────────────────
// The walk taints BACKWARD from outflow primitives, so a route whose whole
// consequence is changing the limits that bind every outflow — rather than
// performing one — reaches no primitive and derives non-capital by
// construction. POST /api/treasury/capital-policy is the worked example: it
// writes the eight bounds that assertCanExpand() and
// assertDailyLossCapNotExceeded() read, and calls nothing tainted.
//
// This is NOT a fourth item of the same kind as the three above. Those are
// things the rule CANNOT SEE. This is something the rule DELIBERATELY DOES NOT
// LOOK FOR: the domain stays "reaches an outflow primitive" and does not extend
// to "governs what an outflow may do". Decided 2026-09-03 —
// bitcorn-research/decisions/2026-09-03-confirmation-coverage-domain-narrow.md.
//
// So do not "fix" this by seeding for it. Widening the seed is the thing that
// was decided against, and a future reader who adds a seed here to close what
// looks like a hole is reopening a closed question, not tightening a loose one.
//
// ── THE GET-ARM BLIND SPOT — latent, not live ──────────────────────────────
// The dispatch enumeration below drops any block whose method literal is GET,
// HEAD or OPTIONS, and handleRequest passes GET and HEAD straight to
// dispatchRequest without classifying them at all. A GET dispatch site that
// reached an outflow primitive would therefore be BOTH outside per-action
// confirmation AND invisible to this test — a case none of the three numbered
// entries covers.
//
// There are currently ZERO such routes. That was established by re-running this
// walk with the method filter removed, across every GET/HEAD block: none
// reaches a tainted callee. The negative is not vacuous — a control seeding a
// read-only function (getCapitalPolicy) lit up GET blocks, proving the GET arm
// scans rather than silently matching nothing.
//
// Latent, not live: nothing to repair today. Re-derive rather than trusting
// this paragraph — drop the method filter, re-run, and read the GET rows.
// ═══════════════════════════════════════════════════════════════════════════

import { beforeAll, describe, expect, it } from "vitest";
import ts from "typescript";
import path from "path";
import { CONFIRMED_ROUTES, EXEMPT_MUTATIONS, type Matcher } from "./action-confirmation";

/** The seed. Functions below which we do not look, because they ARE the egress. */
const OUTFLOW_PRIMITIVES: Array<[file: string, name: string]> = [
  ["lightning/lnd.ts", "sendLndToChainAddress"],
  ["lightning/lnd.ts", "openTreasuryChannel"],
  ["lightning/lnd.ts", "closeTreasuryChannel"],
  ["lightning/lnd.ts", "keysendPush"],
  ["lightning/lnd.ts", "payLndViaRoutes"],
  ["lightning/pay.ts", "payInvoice"],
  ["lightning/loop.ts", "executeLoopOutSwap"],
  ["lightning/loop.ts", "executeLoopInSwap"],
  ["autoBuy/coinbaseClient.ts", "placeMarketBuy"],
  ["autoBuy/coinbaseClient.ts", "placeWithdraw"],
];

/**
 * ln-service exports that move funds, and the only files allowed to import
 * them. This is what stops OUTFLOW_PRIMITIVES from being a list nobody updates:
 * a new route cannot reach LND's money-moving surface without going through one
 * of these two files, and adding a call there is visible.
 */
const FUND_MOVING_LN_SERVICE = [
  "openChannel",
  "closeChannel",
  "payViaRoutes",
  "payViaPaymentDetails",
  "payViaPaymentRequest",
  "sendToChainAddress",
];
const LN_SERVICE_EGRESS_FILES = ["lightning/lnd.ts", "lightning/pay.ts"];

/** Built-ins on `any`-typed values. Terminal: they cannot reach project code. */
const BUILTIN_METHODS = new Set([
  "includes", "split", "join", "trim", "toString", "slice", "map", "filter",
  "replace", "startsWith", "endsWith", "toLowerCase", "toUpperCase", "padStart",
  "padEnd", "indexOf", "concat", "find", "some", "every", "push", "sort",
  "match", "test", "reduce", "flat", "keys", "values", "entries", "then",
  "catch", "toFixed", "charAt", "substring", "repeat", "at",
]);

const API_ROOT = path.resolve(__dirname, "..", "..");
const SRCMARK = `${path.sep}src${path.sep}`;

type Gap = { file: string; line: number; text: string; kind: string };
type Derived = {
  program: ts.Program;
  checker: ts.TypeChecker;
  mutations: Array<{ method: string; matchers: Matcher[]; capital: boolean; hits: string[] }>;
  gaps: Gap[];
  valueRefs: string[];
  lnServiceImports: Array<{ file: string; names: string[] }>;
};

let D: Derived;

// ── build once; createProgram over 1800 files is the expensive part
beforeAll(() => {
  D = derive();
}, 60_000);

function derive(): Derived {
  const cfgPath = ts.findConfigFile(API_ROOT, ts.sys.fileExists, "tsconfig.json")!;
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(cfgPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();

  const rel = (f: string) => (f.includes(SRCMARK) ? f.split(SRCMARK)[1] : f);
  const isOurs = (f: string) => f.includes(SRCMARK) && !f.endsWith(".d.ts") && !f.endsWith(".test.ts");
  const K = (f: string, n: string) => `${rel(f)}::${n}`;

  const gaps: Gap[] = [];
  const valueRefs: string[] = [];
  const lnServiceImports: Array<{ file: string; names: string[] }> = [];
  const callsFrom = new Map<string, Set<string>>();
  const primNames = new Set(OUTFLOW_PRIMITIVES.map(([, n]) => n));

  function nameOfDecl(d: ts.Declaration): string | null {
    if (ts.isFunctionDeclaration(d) && d.name) return d.name.text;
    if (ts.isBindingElement(d)) {
      const src = d.propertyName ?? d.name;
      return ts.isIdentifier(src) ? src.text : null;
    }
    if ((ts.isVariableDeclaration(d) || ts.isMethodDeclaration(d)) && d.name && ts.isIdentifier(d.name)) {
      return d.name.text;
    }
    if (ts.isImportSpecifier(d)) return (d.propertyName ?? d.name).text;
    return null;
  }

  function enclosing(n: ts.Node): string {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name) return K(p.getSourceFile().fileName, p.name.text);
      if (
        (ts.isFunctionExpression(p) || ts.isArrowFunction(p)) &&
        p.parent &&
        ts.isVariableDeclaration(p.parent) &&
        ts.isIdentifier(p.parent.name)
      ) {
        return K(p.getSourceFile().fileName, p.parent.name.text);
      }
    }
    return K(n.getSourceFile().fileName, "<module-scope>");
  }

  /** Resolve a call's callee to declarations, or explain why it cannot be. */
  function calleeDecls(call: ts.CallExpression): ts.Declaration[] | { gap: string } {
    const expr = call.expression;
    if (expr.kind === ts.SyntaxKind.ImportKeyword) return { gap: "dynamic-import" };

    let sym = checker.getSymbolAtLocation(expr);
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      try {
        sym = checker.getAliasedSymbol(sym);
      } catch {
        /* not an alias after all */
      }
    }
    let decls: ts.Declaration[] = sym?.getDeclarations?.()?.slice() ?? [];

    // one hop through `const f = someFn`
    for (const d of [...decls]) {
      if (ts.isVariableDeclaration(d) && d.initializer && ts.isIdentifier(d.initializer)) {
        let s2 = checker.getSymbolAtLocation(d.initializer);
        if (s2 && s2.flags & ts.SymbolFlags.Alias) {
          try {
            s2 = checker.getAliasedSymbol(s2);
          } catch {
            /* ignore */
          }
        }
        decls.push(...(s2?.getDeclarations?.() ?? []));
      }
    }

    if (decls.length === 0) {
      // fall back to the callee's own call signatures
      const t = checker.getTypeAtLocation(expr);
      for (const s of t?.getCallSignatures?.() ?? []) if (s.declaration) decls.push(s.declaration);
    }

    // A binding element from `const { fn } = await import("mod")` DECLARES fn in
    // the importing file, not in mod — so keying taint on it would look up
    // "payFromNode.ts::sendLndToChainAddress" and miss the seed entirely. Follow
    // the binding's TYPE to the real function declaration.
    //
    // This is not hypothetical tidying: /api/subscription/pay-from-node reaches
    // sendLndToChainAddress by exactly this route, and the canary test above
    // failed on it before this expansion existed.
    for (const d of [...decls]) {
      if (!ts.isBindingElement(d) && !ts.isVariableDeclaration(d)) continue;
      const nameNode = d.name;
      if (!ts.isIdentifier(nameNode)) continue;
      const bt = checker.getTypeAtLocation(nameNode);
      for (const s of bt?.getCallSignatures?.() ?? []) {
        if (s.declaration && s.declaration !== d) decls.push(s.declaration);
      }
    }

    if (decls.length === 0) {
      if (ts.isPropertyAccessExpression(expr) && BUILTIN_METHODS.has(expr.name.text)) {
        return { gap: "builtin-on-any" };
      }
      if (ts.isElementAccessExpression(expr)) return { gap: "computed-member" };
      return { gap: "unresolved" };
    }
    return decls;
  }

  for (const sf of program.getSourceFiles()) {
    if (!isOurs(sf.fileName)) continue;

    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === "ln-service") {
        const names: string[] = [];
        const nb = n.importClause?.namedBindings;
        if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) names.push((e.propertyName ?? e.name).text);
        lnServiceImports.push({ file: rel(sf.fileName), names });
      }

      if (ts.isCallExpression(n)) {
        const from = enclosing(n);
        const r = calleeDecls(n);
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
        if ("gap" in r) {
          gaps.push({ file: rel(sf.fileName), line: line + 1, text: n.getText().slice(0, 80).replace(/\s+/g, " "), kind: r.gap });
        } else {
          if (!callsFrom.has(from)) callsFrom.set(from, new Set());
          for (const d of r) {
            const nm = nameOfDecl(d);
            const df = d.getSourceFile().fileName;
            if (nm && isOurs(df)) callsFrom.get(from)!.add(K(df, nm));
          }
        }
      }

      // A primitive used as a VALUE would escape a call-graph walk entirely.
      if (ts.isIdentifier(n) && primNames.has(n.text)) {
        const p = n.parent;
        const benign =
          (ts.isCallExpression(p) && p.expression === n) ||
          ts.isImportSpecifier(p) ||
          ts.isBindingElement(p) ||
          ts.isExportSpecifier(p) ||
          (ts.isFunctionDeclaration(p) && p.name === n) ||
          (ts.isPropertyAccessExpression(p) && p.name === n);
        if (!benign) {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
          valueRefs.push(`${rel(sf.fileName)}:${line + 1}  ${p.getText().slice(0, 80).replace(/\s+/g, " ")}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // ── taint: reverse-reachability to the primitives
  const tainted = new Set(OUTFLOW_PRIMITIVES.map(([f, n]) => `${f}::${n}`));
  for (let round = 0; round < 40; round++) {
    let changed = false;
    for (const [caller, callees] of callsFrom) {
      if (tainted.has(caller)) continue;
      for (const c of callees) {
        if (tainted.has(c)) {
          tainted.add(caller);
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }

  // ── dispatch enumeration out of dispatchRequest
  const indexFile = program.getSourceFiles().find((f) => f.fileName.endsWith(`${path.sep}src${path.sep}index.ts`))!;
  const dispatchFn = indexFile.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "dispatchRequest"
  );
  if (!dispatchFn) throw new Error("dispatchRequest not found in index.ts — the dispatch chain moved");

  const mutations: Derived["mutations"] = [];
  for (const stmt of dispatchFn.body?.statements ?? []) {
    if (!ts.isIfStatement(stmt)) continue;

    let method: string | null = null;
    const exacts: string[] = [];
    let prefix: string | null = null;
    let suffix: string | null = null;

    const scan = (e: ts.Node): void => {
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
        const lhs = e.left.getText().replace(/[?]/g, "");
        if (lhs === "req.method" && ts.isStringLiteral(e.right)) method = e.right.text;
        if (lhs === "req.url" && ts.isStringLiteral(e.right)) exacts.push(e.right.text);
      }
      if (ts.isCallExpression(e)) {
        const callee = e.expression.getText().replace(/[?]/g, "");
        const arg = e.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          if (callee === "req.url.startsWith") prefix = arg.text;
          if (callee === "req.url.endsWith") suffix = arg.text;
        }
      }
      ts.forEachChild(e, scan);
    };
    scan(stmt.expression);

    if (!method || method === "GET" || method === "HEAD" || method === "OPTIONS") continue;

    const matchers: Matcher[] = [];
    if (prefix && suffix) matchers.push({ kind: "wrap", prefix, suffix });
    else if (prefix) matchers.push({ kind: "prefix", url: prefix });
    for (const u of exacts) matchers.push({ kind: "exact", url: u });
    if (matchers.length === 0) continue;

    // does this block reach an outflow primitive?
    const hits = new Set<string>();
    const seen = new Set<string>();
    const walkBlock = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const r = calleeDecls(n);
        if (!("gap" in r)) {
          for (const d of r) {
            const nm = nameOfDecl(d);
            const df = d.getSourceFile().fileName;
            if (!nm || !isOurs(df)) continue;
            const k = K(df, nm);
            if (seen.has(k)) continue;
            seen.add(k);
            if (tainted.has(k)) hits.add(nm);
          }
        }
      }
      ts.forEachChild(n, walkBlock);
    };
    walkBlock(stmt.thenStatement);

    mutations.push({ method, matchers, capital: hits.size > 0, hits: [...hits] });
  }

  return { program, checker, mutations, gaps, valueRefs, lnServiceImports };
}

// ── comparison helpers
const mkey = (m: Matcher) =>
  m.kind === "exact" ? `=${m.url}` : m.kind === "prefix" ? `^${m.url}` : `^${m.prefix}$${m.suffix}`;
const rkeys = (method: string, ms: Matcher[]) => ms.map((m) => `${method} ${mkey(m)}`);

describe("the derivation itself is working", () => {
  it("found the dispatch chain and a plausible number of mutations", () => {
    expect(D.mutations.length).toBeGreaterThan(40);
  });

  it("resolves the dynamic-import outflow path that a regex walk loses", () => {
    // /api/subscription/pay-from-node reaches sendLndToChainAddress only via
    // `const { … } = await import("../lightning/lnd")`. If this stops being
    // detected as capital, the walk has silently regressed to the naive form.
    const payFromNode = D.mutations.find((m) =>
      rkeys(m.method, m.matchers).includes("POST =/api/subscription/pay-from-node")
    );
    expect(payFromNode, "pay-from-node dispatch site not found").toBeDefined();
    expect(payFromNode!.capital, "pay-from-node must derive as capital-reaching").toBe(true);
  });

  it("no outflow primitive is passed around as a VALUE", () => {
    // A call-graph walk follows calls. A primitive stored in a variable, put in
    // a table or handed to a callback would slip past it entirely, so the walk
    // is only trustworthy while this stays empty.
    expect(D.valueRefs).toEqual([]);
  });
});

describe("every capital dispatch site is classified", () => {
  it("the derived capital set equals CONFIRMED_ROUTES plus the declared no-parameter exemptions", () => {
    const derivedCapital = new Set(D.mutations.filter((m) => m.capital).flatMap((m) => rkeys(m.method, m.matchers)));

    const declared = new Set<string>([
      ...CONFIRMED_ROUTES.flatMap((r) => rkeys(r.method, [r.match])),
      // Reachable, but excluded by decision because no consequential
      // caller-supplied parameter exists to prove knowledge of.
      ...EXEMPT_MUTATIONS.filter((e) => e.why === "group3-no-parameter").flatMap((e) => rkeys(e.method, [e.match])),
    ]);

    const unclassified = [...derivedCapital].filter((k) => !declared.has(k));
    const stale = [...declared].filter((k) => !derivedCapital.has(k));

    expect(
      unclassified,
      `Dispatch sites reach an outflow primitive but are NOT in action-confirmation.ts.\n` +
        `Add each to CONFIRMED_ROUTES, or to EXEMPT_MUTATIONS with why="group3-no-parameter"\n` +
        `if it genuinely has no consequential caller-supplied field:\n  ${unclassified.join("\n  ")}`
    ).toEqual([]);

    expect(
      stale,
      `Declared capital-reaching, but the walk no longer finds an outflow path.\n` +
        `Either the route stopped moving funds (remove it) or the walk lost sight of it (worse):\n  ${stale.join("\n  ")}`
    ).toEqual([]);
  });

  it("the exempt list is exactly the complement — no mutation is unclassified", () => {
    const derivedAll = new Set(D.mutations.flatMap((m) => rkeys(m.method, m.matchers)));
    const declaredAll = new Set<string>([
      ...CONFIRMED_ROUTES.flatMap((r) => rkeys(r.method, [r.match])),
      ...EXEMPT_MUTATIONS.flatMap((e) => rkeys(e.method, [e.match])),
    ]);

    const missing = [...derivedAll].filter((k) => !declaredAll.has(k));
    const phantom = [...declaredAll].filter((k) => !derivedAll.has(k));

    expect(
      missing,
      `Mutation dispatch sites in index.ts with no entry in action-confirmation.ts.\n` +
        `These currently fail CLOSED at runtime (400 confirmation_required) — classify them:\n  ${missing.join("\n  ")}`
    ).toEqual([]);
    expect(
      phantom,
      `Entries in action-confirmation.ts matching no dispatch site — a route was removed or renamed:\n  ${phantom.join("\n  ")}`
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The refusal half. Without this the walk would be "best effort" and its green
// would mean "found nothing I could see", which is not the same claim.
// ─────────────────────────────────────────────────────────────────────────────
describe("the walk refuses rather than guessing", () => {
  it("every unresolvable call is a recognised benign shape", () => {
    const unclassified = D.gaps.filter((g) => g.kind === "unresolved" || g.kind === "computed-member");
    // `computed-member` is genuine dynamic dispatch — today the only one is
    // loop.ts's gRPC invoker, which sits BELOW the primitive boundary. One
    // above it would be a real blind spot and must be resolved by hand.
    const allowed = new Set(["lightning/loop.ts:96"]);
    const offending = unclassified
      .map((g) => ({ ...g, id: `${g.file}:${g.line}` }))
      .filter((g) => !allowed.has(g.id));

    expect(
      offending.map((g) => `${g.id} [${g.kind}] ${g.text}`),
      `Calls the analysis cannot resolve. Each one is a place a capital path could\n` +
        `hide from this test. Resolve it (give the value a type) or, if it provably\n` +
        `cannot reach an outflow, add it to the allowlist WITH a reason:`
    ).toEqual([]);
  });

  it("reports how much it could not see, so a silent drift in that number is visible", () => {
    const byKind: Record<string, number> = {};
    for (const g of D.gaps) byKind[g.kind] = (byKind[g.kind] ?? 0) + 1;
    // Not an assertion on the exact count — that would churn on every edit.
    // The assertion is that nothing is in the un-triaged bucket.
    expect(byKind["unresolved"] ?? 0).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EGRESS CONTAINMENT. This is what keeps OUTFLOW_PRIMITIVES from silently
// going stale: a new capital path cannot appear without either calling one of
// those functions, or importing LND's fund-moving surface somewhere new.
// ─────────────────────────────────────────────────────────────────────────────
describe("egress containment", () => {
  it("fund-moving ln-service calls stay inside the two lightning modules", () => {
    const violations: string[] = [];
    for (const imp of D.lnServiceImports) {
      if (LN_SERVICE_EGRESS_FILES.includes(imp.file)) continue;
      const moving = imp.names.filter((n) => FUND_MOVING_LN_SERVICE.includes(n));
      if (moving.length) violations.push(`${imp.file} imports ${moving.join(", ")}`);
    }
    expect(
      violations,
      `A file outside ${LN_SERVICE_EGRESS_FILES.join(" / ")} imports an ln-service function that moves\n` +
        `funds. The confirmation coverage walk seeds from a fixed primitive list, so a\n` +
        `call here is an outflow path it cannot see. Route it through lightning/lnd.ts\n` +
        `or lightning/pay.ts, or add a new seed to OUTFLOW_PRIMITIVES deliberately:`
    ).toEqual([]);
  });

  it("the two egress modules really are where those imports live (not a vacuous pass)", () => {
    // If ln-service were renamed or the imports restructured, the assertion
    // above would pass by finding nothing at all. Prove it is finding them.
    const found = D.lnServiceImports
      .filter((i) => LN_SERVICE_EGRESS_FILES.includes(i.file))
      .flatMap((i) => i.names)
      .filter((n) => FUND_MOVING_LN_SERVICE.includes(n));
    expect(found.length, "no fund-moving ln-service imports found at all — the check is vacuous").toBeGreaterThan(3);
  });
});
