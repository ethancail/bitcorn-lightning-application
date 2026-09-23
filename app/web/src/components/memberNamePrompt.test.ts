import { describe, it, expect } from "vitest";
import { memberNamePromptFor } from "./memberNamePrompt";

// Descriptor controls for the member-name prompt — spec 2026-09-23-member-
// name-prompt §7.1, §9.1, §9.4.
//
// ⚠ ORDER IS DELIBERATE: the PERMITTING control leads (§9.1). A suite that
// only asserts the prompt appears passes on a descriptor that always renders.
//
// ⚠ Every "no prompt" case sits beside a paired positive built from the same
// shape (§9.4), so a descriptor that never renders fails the pair.
//
// Copy is hardcoded here ON PURPOSE (§8): the strings are proposed, not
// accepted, and a revision should fail this file rather than slip through.

const HEADLINE = "Add a name for your farm";
const BODY =
  "Pick a name for BitCorn to use for you. It's kept on your node, not announced to the Lightning network.";
const ACTION = "Add name in Settings →";

describe("memberNamePromptFor", () => {
  it("§9.1 PERMITTING CONTROL: a loaded, stored name → no prompt", () => {
    expect(memberNamePromptFor({ state: "loaded", bitcorn_name: "Green Acres" })).toEqual({ render: false });
  });

  it("§9.4 paired positive: loaded with NO name → the prompt, with its copy", () => {
    expect(memberNamePromptFor({ state: "loaded", bitcorn_name: null })).toEqual({
      render: true,
      headline: HEADLINE,
      body: BODY,
      actionLabel: ACTION,
    });
  });

  it("§7.1 a FAILED read does not collapse into 'unset' → no prompt", () => {
    expect(memberNamePromptFor({ state: "failed" })).toEqual({ render: false });
  });

  it("still loading → no prompt", () => {
    expect(memberNamePromptFor({ state: "loading" })).toEqual({ render: false });
  });

  it("§8 copy constraint: nothing in the prompt promises the treasury (or anyone) will see the name", () => {
    const p = memberNamePromptFor({ state: "loaded", bitcorn_name: null });
    if (!p.render) throw new Error("paired positive did not render");
    const all = `${p.headline} ${p.body} ${p.actionLabel}`.toLowerCase();
    for (const forbidden of ["treasury", "operator", "hub will", "will see", "visible to"]) {
      expect(all, forbidden).not.toContain(forbidden);
    }
  });
});
