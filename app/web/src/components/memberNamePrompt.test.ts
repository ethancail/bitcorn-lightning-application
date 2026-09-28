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
// Copy is hardcoded here ON PURPOSE (§8), so a revision fails this file
// rather than slipping through. HEADLINE and ACTION are ACCEPTED (Ethan,
// 2026-09-23). BODY is ACCEPTED (Ethan, 2026-09-28; D8 spec §10): it replaced
// the "stays on your node for now / in an upcoming update" body when the
// transport shipped, and this file went red on that change before it was
// revised to match.

const HEADLINE = "Add your name or business name";
const BODY =
  "It's shared with BitCorn so we know who you are. It's never announced to the Lightning network.";
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

  // Revised deliberately by D8 (spec §10; ACCEPTED — Ethan, 2026-09-28). The list used to also
  // forbid "hub will", "will see" and "visible to" — tense guards that existed
  // only for the pre-transport window, when nothing could see the name. Now
  // BitCorn does. What remains binding: member-facing copy says "BitCorn", and
  // never "operator" — the farmer IS the operator of their own node.
  it("§8 copy constraint: the prompt says 'BitCorn', never 'treasury' or 'operator'", () => {
    const p = memberNamePromptFor({ state: "loaded", bitcorn_name: null });
    if (!p.render) throw new Error("paired positive did not render");
    const all = `${p.headline} ${p.body} ${p.actionLabel}`.toLowerCase();
    for (const forbidden of ["treasury", "operator"]) {
      expect(all, forbidden).not.toContain(forbidden);
    }
    // Anti-vacuity: the word the copy is meant to use IS there.
    expect(p.body).toContain("BitCorn");
  });

  // ⚠ INVERTED DELIBERATELY by D8 (spec §10). This used to pin that the body
  // SAID "for now" — present-tense honesty while the name stayed on the node.
  // Once the transport ships, "for now" / "upcoming update" are the false
  // words, so the same honesty now requires them ABSENT.
  it("§8 present-tense honesty (post-transport): the body no longer says 'for now' or 'upcoming update'", () => {
    const p = memberNamePromptFor({ state: "loaded", bitcorn_name: null });
    if (!p.render) throw new Error("paired positive did not render");
    expect(p.body).not.toContain("for now");
    expect(p.body).not.toContain("upcoming update");
    expect(p.body).toContain("shared with BitCorn");
  });

  // Why this exists: the replaced headline ("Add a name for your farm")
  // addressed only farmers, and grain merchants are half the membership. The
  // prompt renders for every unnamed member regardless of channel role, so its
  // headline must not assume one.
  it("§8 addresses every member: the headline does not say 'farm'", () => {
    const p = memberNamePromptFor({ state: "loaded", bitcorn_name: null });
    if (!p.render) throw new Error("paired positive did not render");
    expect(p.headline.toLowerCase()).not.toContain("farm");
  });
});
