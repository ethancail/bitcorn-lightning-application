// Read a request body once, then hand downstream code a request it can read
// again from the start.
//
// WHY THIS EXISTS. The confirmation gate has to see the body BEFORE dispatch,
// because what it verifies is the caller's knowledge of the body's own fields.
// The body is a stream and a stream is consumed once. Every route in index.ts
// reads it the same way — `req.on("data")` / `req.on("end")` — so rather than
// edit 50-odd route bodies (a large diff across live payment paths for a
// mechanical reason), the gate buffers the bytes and dispatch receives a stand-in
// that replays them.
//
// The stand-in is `Object.create(req)`, so everything the routes actually touch
// — `headers`, `method`, `url`, `socket`, `httpVersion`, and `instanceof
// http.IncomingMessage` — resolves through the prototype chain to the real
// request untouched. Only the read path is shadowed.
//
// ⚠ This is request plumbing on a production Lightning node. The property that
// matters is that a route reading the stand-in sees EXACTLY the bytes that
// arrived — same content, same encoding, no truncation on an empty body and no
// double-delivery. request-replay.test.ts asserts that against both idioms in
// the codebase, and asserts the negative: that reading the ORIGINAL request a
// second time yields nothing, which is the whole reason this exists.

import http from "http";
import { PassThrough } from "stream";

/** Stream-read members shadowed onto the stand-in. Everything else inherits. */
const READ_PATH = [
  "on",
  "once",
  "addListener",
  "removeListener",
  "off",
  "prependListener",
  "prependOnceListener",
  "pipe",
  "unpipe",
  "read",
  "setEncoding",
  "resume",
  "pause",
  "isPaused",
  "unshift",
  "wrap",
] as const;

/** Collect the full request body. Resolves to an empty Buffer for no body. */
export function readRawBody(req: http.IncomingMessage, limitBytes = 1_048_576): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      // A body this large is not a legitimate request to any route here; refuse
      // rather than buffer without bound.
      if (size > limitBytes) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * A request that reads as `raw`, and is otherwise the original request.
 *
 * The PassThrough is ended synchronously with the buffered bytes, so a listener
 * attached at any later point still receives them — Node replays a stream's
 * buffered data to a `data` listener added after the fact, which is what makes
 * both `req.on("data")` and an awaited promise wrapper work unchanged.
 */
export function withReplayableBody(
  req: http.IncomingMessage,
  raw: Buffer
): http.IncomingMessage {
  const replay = new PassThrough();
  replay.end(raw);

  const standIn = Object.create(req) as http.IncomingMessage;
  for (const key of READ_PATH) {
    const fn = (replay as unknown as Record<string, unknown>)[key];
    if (typeof fn === "function") {
      Object.defineProperty(standIn, key, {
        value: (fn as (...a: unknown[]) => unknown).bind(replay),
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  }
  Object.defineProperty(standIn, Symbol.asyncIterator, {
    value: () => replay[Symbol.asyncIterator](),
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return standIn;
}
