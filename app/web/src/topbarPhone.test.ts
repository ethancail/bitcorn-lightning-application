// J8 (PR 2): on a phone the top bar shows the name only. At 390px the node ID
// ran the bar off the edge; the phone rule now hides it and lets a long name
// end in an ellipsis. Read from styles.css (jsdom does not evaluate @media);
// the 390x844 capture is the evidence of how it renders.

import { describe, expect, it } from "vitest";
import { declsFor } from "./styleRules.testutil";

const PHONE = "(max-width: 767px)";

describe("J8 phone top bar", () => {
  it("hides the node ID on a phone", () => {
    expect(declsFor(".topbar-node-id", PHONE).display).toBe("none");
  });

  it("keeps the node ID on desktop", () => {
    expect(declsFor(".topbar-node-id").display).toBeUndefined();
  });

  it("lets the name shrink and end in an ellipsis on a phone", () => {
    expect(declsFor(".topbar-node", PHONE)["min-width"]).toBe("0");
    expect(declsFor(".topbar-node-name", PHONE)).toMatchObject({
      "min-width": "0",
      overflow: "hidden",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    });
  });
});
