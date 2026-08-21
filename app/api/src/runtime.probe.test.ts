// RUNTIME PROBE — asserts the version the SUITE runs on, from inside the suite.
//
// WHY THIS FILE EXISTS. Prepending a Node 20 bin directory to PATH does not
// prove the test runner used it: `npx vitest` resolves node through the shebang,
// so a shell-level `node --version` echo proves only that the ECHO ran on Node
// 20. It says nothing about the process executing the tests. Four commits
// shipped on evidence gathered under the wrong runtime; this is the check that
// makes that class of mistake loud instead of silent.
//
// The repo pins Node 20 (.nvmrc = "20"; app/api/Dockerfile builds and runs on
// node:20-slim). crypto.X509Certificate — which the cert-expiry work depends on
// — has existed since Node 15.6, so a NEWER runtime would not fail the cert
// tests. It would just mean the evidence came from a runtime production never
// uses. Hence an exact-major assertion rather than a floor.

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

  it("has crypto.X509Certificate available (the cert-expiry work depends on it)", async () => {
    const { X509Certificate } = await import("crypto");
    expect(typeof X509Certificate).toBe("function");
  });
});
