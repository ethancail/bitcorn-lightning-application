// R59(6) [RELAYED — drive-mode arc chat, 2026-11-12]: radio cards in
// drive-mode's own component, shaped EXACTLY like member-first-run-ui's
// proposed Choice — name, label | labelledBy, options [{ value, label,
// description?, meta?, icon?, badge?, disabled?, disabledReason? }], value,
// onChange, layout, busy? — using native input[type=radio][value=key] inside
// label cards.
//   - one native radio per option, all sharing `name`, value = the key
//   - CONTROLLED: checked follows `value`; a click only reports (the page
//     commits the choice with its one Save, R59(6))
//   - a disabled option: its radio is disabled, its disabledReason shows, and
//     a click reports nothing
//   - busy: every radio is off
//   - the group is named (label or labelledBy); description and meta describe
//     the radio
// Arrow-key movement between radios is the browser's (native radios sharing a
// name); jsdom does not implement it, so the fixture capture shows it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { RadioCards, type RadioCardsProps } from "./RadioCards";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

const OPTIONS: RadioCardsProps<"save" | "open">["options"] = [
  { value: "save", label: "Wait for low fees", description: "Cheapest.", badge: "Recommended", meta: "Too small for this yet." },
  { value: "open", label: "Move sooner", description: "Costs a little more.", disabled: true, disabledReason: "Needs a bigger connection" },
];

async function render(p: Partial<RadioCardsProps<"save" | "open">> = {}) {
  const onChange = p.onChange ?? vi.fn();
  await act(async () => {
    root.render(React.createElement(RadioCards<"save" | "open">, {
      name: "strategy", label: "How should Bitcorn move your earnings?", options: OPTIONS, value: "save", onChange, layout: "column", ...p,
    }));
  });
  return onChange;
}

const radios = () => [...host.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
const radio = (v: string) => host.querySelector(`input[type="radio"][value="${v}"]`) as HTMLInputElement;

describe("runtime", () => {
  it("runs on Node 20 (the pinned runtime)", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });
});

describe("native radios inside label cards", () => {
  it("one radio per option, value = the key, all sharing the name", async () => {
    await render();
    expect(radios().map((r) => r.value)).toEqual(["save", "open"]);
    expect(radios().every((r) => r.name === "strategy")).toBe(true);
    expect(radios().every((r) => r.closest("label") != null)).toBe(true);
  });

  it("the group is a named radiogroup (label)", async () => {
    await render();
    const g = host.querySelector('[role="radiogroup"]')!;
    expect(g.getAttribute("aria-label")).toBe("How should Bitcorn move your earnings?");
  });

  it("the group is a named radiogroup (labelledBy)", async () => {
    await render({ label: undefined, labelledBy: "q-id" });
    const g = host.querySelector('[role="radiogroup"]')!;
    expect(g.getAttribute("aria-labelledby")).toBe("q-id");
    expect(g.hasAttribute("aria-label")).toBe(false);
  });

  it("label, badge, description and meta render; description and meta describe the radio", async () => {
    await render();
    const card = radio("save").closest("label")!;
    expect(card.textContent).toContain("Wait for low fees");
    expect(card.querySelector(".badge")?.textContent).toBe("Recommended");
    const described = (radio("save").getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["Cheapest.", "Too small for this yet."]);
  });

  it("layout lands on the group", async () => {
    await render({ layout: "row" });
    expect(host.querySelector('[role="radiogroup"]')!.getAttribute("data-layout")).toBe("row");
  });
});

describe("controlled: a click reports, the value prop decides", () => {
  it("checked follows value", async () => {
    await render({ value: "save", options: [OPTIONS[0], { ...OPTIONS[1], disabled: false }] });
    expect(radio("save").checked).toBe(true);
    expect(radio("open").checked).toBe(false);
  });

  it("clicking another card calls onChange with its key, and nothing changes until value does", async () => {
    const onChange = await render({ value: "save", options: [OPTIONS[0], { ...OPTIONS[1], disabled: false }] });
    await act(async () => { radio("open").click(); });
    expect(onChange).toHaveBeenCalledWith("open");
    expect(radio("save").checked).toBe(true);
    expect(radio("open").checked).toBe(false);
  });
});

describe("disabled and busy", () => {
  it("a disabled option: its radio is disabled and its reason shows", async () => {
    await render();
    expect(radio("open").disabled).toBe(true);
    expect(radio("open").closest("label")!.textContent).toContain("Needs a bigger connection");
  });

  it("a click on a disabled option reports nothing", async () => {
    const onChange = await render();
    await act(async () => { radio("open").click(); });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("no reason shows on an option that is not disabled", async () => {
    await render({ options: [OPTIONS[0], { ...OPTIONS[1], disabled: false }] });
    expect(host.textContent).not.toContain("Needs a bigger connection");
  });

  it("busy: every radio is off", async () => {
    await render({ busy: true, options: [OPTIONS[0], { ...OPTIONS[1], disabled: false }] });
    expect(radios().every((r) => r.disabled)).toBe(true);
    expect(host.querySelector('[role="radiogroup"]')!.getAttribute("aria-busy")).toBe("true");
  });
});
