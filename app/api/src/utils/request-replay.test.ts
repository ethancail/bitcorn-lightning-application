import { describe, expect, it } from "vitest";
import { PassThrough } from "stream";
import type http from "http";
import { readRawBody, withReplayableBody } from "./request-replay";

function fakeReq(headers: Record<string, string> = {}): http.IncomingMessage {
  const s = new PassThrough() as unknown as http.IncomingMessage;
  (s as any).method = "POST";
  (s as any).url = "/api/pay";
  (s as any).headers = { host: "umbrel.local", ...headers };
  return s;
}

/** The `req.on("data")/("end")` idiom used by every route in index.ts. */
function readViaEvents(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => resolve(body));
  });
}

/** swapRoutes.ts's parseBody wraps the same idiom in a promise. */
const parseBodyStyle = readViaEvents;

describe("readRawBody", () => {
  it("collects the whole body", async () => {
    const req = fakeReq();
    const p = readRawBody(req);
    (req as unknown as PassThrough).end('{"a":1}');
    expect((await p).toString()).toBe('{"a":1}');
  });

  it("collects a body split across chunks", async () => {
    const req = fakeReq();
    const p = readRawBody(req);
    const s = req as unknown as PassThrough;
    s.write('{"payment_re');
    s.write('quest":"lnbc1"}');
    s.end();
    expect((await p).toString()).toBe('{"payment_request":"lnbc1"}');
  });

  it("yields an EMPTY buffer for no body, not a hang", async () => {
    const req = fakeReq();
    const p = readRawBody(req);
    (req as unknown as PassThrough).end();
    expect((await p).length).toBe(0);
  });

  it("refuses a body over the limit rather than buffering without bound", async () => {
    const req = fakeReq();
    const p = readRawBody(req, 16);
    (req as unknown as PassThrough).write("x".repeat(64));
    await expect(p).rejects.toThrow("body_too_large");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE NEGATIVE CONTROL FIRST. If reading the original request a second time
// silently produced the body again, every assertion below would pass without
// the replay doing anything at all — and this whole module would be pointless
// code that appears verified. Prove the stream is spent BEFORE proving the
// stand-in works.
// ─────────────────────────────────────────────────────────────────────────────
describe("the problem this module exists for", () => {
  it("re-reading the ORIGINAL request after readRawBody yields NOTHING", async () => {
    const req = fakeReq();
    const p = readRawBody(req);
    (req as unknown as PassThrough).end('{"a":1}');
    expect((await p).toString()).toBe('{"a":1}');

    const second = await Promise.race([
      readViaEvents(req),
      new Promise<string>((r) => setTimeout(() => r("__NEVER_ENDED__"), 200)),
    ]);
    expect(second).not.toBe('{"a":1}');
  });
});

describe("withReplayableBody", () => {
  it("replays the body to the req.on(\"data\") idiom", async () => {
    const req = fakeReq();
    const raw = Buffer.from('{"payment_request":"lnbc1"}');
    const standIn = withReplayableBody(req, raw);
    expect(await readViaEvents(standIn)).toBe('{"payment_request":"lnbc1"}');
  });

  it("replays to the awaited parseBody idiom too", async () => {
    const req = fakeReq();
    const standIn = withReplayableBody(req, Buffer.from('{"swap_request_id":"abc"}'));
    expect(await parseBodyStyle(standIn)).toBe('{"swap_request_id":"abc"}');
  });

  it("replays to a listener attached LATE (after a tick)", async () => {
    const req = fakeReq();
    const standIn = withReplayableBody(req, Buffer.from("late"));
    await new Promise((r) => setImmediate(r));
    expect(await readViaEvents(standIn)).toBe("late");
  });

  it("replays an EMPTY body as an immediate end, not a hang", async () => {
    const req = fakeReq();
    const standIn = withReplayableBody(req, Buffer.alloc(0));
    const got = await Promise.race([
      readViaEvents(standIn),
      new Promise<string>((r) => setTimeout(() => r("__HUNG__"), 500)),
    ]);
    expect(got).toBe("");
  });

  it("preserves bytes exactly, including multi-byte UTF-8", async () => {
    const req = fakeReq();
    const payload = JSON.stringify({ name: "café ☕ 日本" });
    const standIn = withReplayableBody(req, Buffer.from(payload, "utf8"));
    expect(await readViaEvents(standIn)).toBe(payload);
  });

  it("delivers the body ONCE, not twice", async () => {
    const req = fakeReq();
    const standIn = withReplayableBody(req, Buffer.from("abc"));
    let seen = "";
    let ends = 0;
    await new Promise<void>((resolve) => {
      standIn.on("data", (c: Buffer) => {
        seen += c.toString();
      });
      standIn.on("end", () => {
        ends++;
        resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toBe("abc");
    expect(ends).toBe(1);
  });

  it("inherits everything routes actually read off the request", () => {
    const req = fakeReq({ origin: "http://100.64.1.2" });
    const standIn = withReplayableBody(req, Buffer.alloc(0));
    expect(standIn.method).toBe("POST");
    expect(standIn.url).toBe("/api/pay");
    expect(standIn.headers.host).toBe("umbrel.local");
    expect(standIn.headers.origin).toBe("http://100.64.1.2");
  });

  it("does not mutate the original request's own read path", async () => {
    const req = fakeReq();
    const standIn = withReplayableBody(req, Buffer.from("x"));
    expect(standIn.on).not.toBe(req.on);
  });
});
