// The exchange boundary (kraken-autobuy spec §2, §3 P1): the scheduler reaches
// an exchange only through ./exchange, never through a provider's client or
// adapter. A direct import would let an I/O site branch on the provider, or skip
// the provider interface altogether.
//
// Read from the AST (ts.createSourceFile, one file, no type program): static
// imports, re-exports, dynamic import() and require() all count. Comments are
// not AST nodes, so a comment naming a module cannot trip it.

import fs from "fs";
import path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SCHEDULER = path.join(__dirname, "scheduler.ts");

/** Modules the scheduler must not import: every provider client and adapter. */
const FORBIDDEN = ["./coinbaseClient", "./coinbaseProvider"];

function moduleSpecifiersOf(file: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      found.push(n.moduleSpecifier.text);
    }
    if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteral(n.arguments[0])) {
      const isDynamicImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      if (isDynamicImport || isRequire) found.push(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("the exchange boundary", () => {
  const specifiers = moduleSpecifiersOf(SCHEDULER);

  it("scheduler.ts imports no provider client or adapter", () => {
    const offending = specifiers.filter((s) => FORBIDDEN.includes(s));
    expect(
      offending,
      `scheduler.ts imports a provider module directly. Reach the exchange through ./exchange instead:\n  ${offending.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the check is not vacuous: it finds scheduler.ts's own imports, ./exchange among them", () => {
    expect(specifiers).toContain("./exchange");
    expect(specifiers).toContain("./caps");
  });
});
