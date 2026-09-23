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

// Named constants so a revision is one edit; the tests hardcode them on
// purpose so a change fails them. Binding constraints the words must keep
// meeting: never claim the name is seen or used TODAY — until the transport
// ships it reaches nobody; never send the farmer to "your node operator"
// (they are the operator).
//
// ⚠ PART-2 COUPLING. The BODY is true only while the name stays on the node:
// its "for now" / "upcoming update" wording MUST change in the same release
// part 2's transport ships — alongside BitcornNamePanel's visibility line,
// which carries the same coupling. Either one left alone becomes false that
// day. (The test pinning "for now" will then need updating too, deliberately.)

// ACCEPTED — Ethan's exact wording, 2026-09-23. It replaced "Add a name for
// your farm", which addressed only farmers; grain merchants are half the
// membership, and the prompt renders for every unnamed member.
export const MEMBER_NAME_PROMPT_HEADLINE = "Add your name or business name";
// ACCEPTED — Ethan's exact wording, 2026-09-23. It replaced "Pick a name for
// BitCorn to use for you…", which passed the forbidden-words test while still
// implying BitCorn uses the name today.
export const MEMBER_NAME_PROMPT_BODY =
  "It stays on your node for now. In an upcoming update it'll be shared with BitCorn so we know who you are. It's never announced to the Lightning network.";
// ACCEPTED — Ethan, 2026-09-23 (unchanged from the spec's proposal).
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
