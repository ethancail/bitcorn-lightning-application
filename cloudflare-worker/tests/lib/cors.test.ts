import { describe, expect, it } from "vitest";
import { CORS_HEADERS } from "../../src/lib/cors";

describe("CORS_HEADERS", () => {
  it("exposes the expected allow headers", () => {
    expect(CORS_HEADERS["Access-Control-Allow-Origin"]).toBe("*");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("GET");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("POST");
    expect(CORS_HEADERS["Access-Control-Allow-Headers"]).toBe("Content-Type");
  });
});
