// Pure descriptor for the member-name prompt on MemberDashboard.
//
// Source: bitcorn-research/specs/2026-09-23-member-name-prompt-spec.md §7-§8
// (D6; D5 §1.1). The subscriptionBanner.ts mold: logic as data, the page is a
// thin renderer, and render:false when there is nothing to say — so a named
// member's dashboard is identical to what it was before this existed.
//
// ⚠ THE READ IS THREE STATES, NOT A NULLABLE NAME. A failed read must never
// render the prompt: that would ask a member who already has a name to set
// one because of a network error ("I don't know" collapsing into a confident
// "unset"). With three states that collapse cannot be represented.
//
// ⚠ THE TRIGGER IS ONLY THE STORED NAME. Not the subscription status or tier
// (null until the first token lands — exactly the first-boot window this is
// for), not the channel, not the role. There is no dismiss: the prompt stays
// until a name is set.

export type BitcornNameRead =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "loaded"; bitcorn_name: string | null };

export type MemberNamePrompt =
  | { render: false }
  | { render: true; headline: string; body: string; actionLabel: string };

// ⚠ COPY IS PROPOSED, NOT ACCEPTED (spec §8) — named constants so a revision
// is one edit; the tests hardcode them on purpose so a change fails them.
// Binding constraints the words must keep meeting: never promise the treasury
// (or anyone) will see the name — until the transport ships it reaches nobody;
// never send the farmer to "your node operator" (they are the operator).
export const MEMBER_NAME_PROMPT_HEADLINE = "Add a name for your farm";
export const MEMBER_NAME_PROMPT_BODY =
  "Pick a name for BitCorn to use for you. It's kept on your node, not announced to the Lightning network.";
export const MEMBER_NAME_PROMPT_ACTION = "Add name in Settings →";

export function memberNamePromptFor(read: BitcornNameRead): MemberNamePrompt {
  if (read.state !== "loaded") return { render: false };
  if (read.bitcorn_name !== null) return { render: false };
  return {
    render: true,
    headline: MEMBER_NAME_PROMPT_HEADLINE,
    body: MEMBER_NAME_PROMPT_BODY,
    actionLabel: MEMBER_NAME_PROMPT_ACTION,
  };
}
