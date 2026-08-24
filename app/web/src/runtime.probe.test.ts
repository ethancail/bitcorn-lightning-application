// RUNTIME PROBE — asserts the version the WEB suite runs on, from inside it.
//
// The API suite has carried this since 43dfe30; the web suite did not, and the
// member cert-expiry banner puts most of its logic on this side. The reasoning
// is identical and worth repeating rather than cross-referencing: prepending a
// Node 20 bin directory to PATH does not prove the runner used it. `npx vitest`
// resolves node through the shebang, so a shell-level `node --version` echo
// proves only that the ECHO ran on Node 20 — nothing about the process
// executing the tests. Four commits shipped on evidence gathered under the
// wrong runtime. This is the check that makes that class of mistake loud.
//
// The repo pins Node 20 (.nvmrc = "20"; app/web/Dockerfile builds on
// node:20-slim). Nothing on this side would FAIL on a newer major — which is
// exactly the hazard: the evidence would silently describe a runtime production
// never uses. Hence an exact-major assertion rather than a floor.
//
// Verified in both directions rather than assumed: run under
// ~/.nvm/versions/node/v22.23.2/bin and this fails naming v22.23.2 and its
// execPath; under v20.20.2 it passes.

import { describe, it, expect } from "vitest";

const EXPECTED_MAJOR = 20; // .nvmrc = "20"; Dockerfile = node:20-slim

describe("test runtime", () => {
  it(`runs on Node ${EXPECTED_MAJOR}.x`, () => {
    const major = Number(process.version.replace(/^v/, "").split(".")[0]);
    expect(
      major,
      `suite is running on ${process.version} (execPath ${process.execPath}), ` +
        `but this repo pins Node ${EXPECTED_MAJOR} via .nvmrc and node:20-slim. ` +
        `Evidence gathered on another major does not describe production.`,
    ).toBe(EXPECTED_MAJOR);
  });
});
