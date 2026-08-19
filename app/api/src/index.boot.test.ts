import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";

// index.ts transitively imports ./db, which opens SQLite at DB_DIR at its own
// module scope. Point it at a scratch dir so importing index.ts does not need
// /data. (That transitive open is db/index.ts's behaviour, not one of the
// boot statements under test here.)
const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-boot-test-"));
process.env.DB_DIR = TMP_DB;

// Spies must be installed BEFORE the module under test is imported.
const createServerSpy = vi.spyOn(http, "createServer");
const listenSpy = vi.spyOn(http.Server.prototype, "listen");
const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

await import("./index");

// The sync IIFE reaches setInterval only after `await syncLndState()` settles,
// so it lands a tick or more after the import returns. Flush before asserting,
// or the interval assertion passes vacuously even against unguarded boot code.
await new Promise(resolve => globalThis.setTimeout(resolve, 300));

describe("importing index.ts must not boot the server", () => {
  it("binds no HTTP listener", () => {
    expect(listenSpy).not.toHaveBeenCalled();
  });

  it("constructs no HTTP server", () => {
    expect(createServerSpy).not.toHaveBeenCalled();
  });

  it("creates no 15s sync interval", () => {
    const syncIntervals = setIntervalSpy.mock.calls.filter(call => call[1] === 15000);
    expect(syncIntervals).toEqual([]);
  });
});
