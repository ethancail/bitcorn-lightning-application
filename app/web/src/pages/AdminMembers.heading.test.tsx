// Copy (PR 2): the Members page heading is typed in sentence case.
//
// It was typed "MEMBERS" in the source, so it rendered in capitals although
// PR 1 left the base h1 rule unchanged (V5) and cut .admin-members-title h1
// back to margin only. Harness: AdminMembers.unidentifiedMarker.test.tsx's.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const PUBKEY = "02" + "a".repeat(64);

const MEMBERS = {
  fetched_at: 1789646400000,
  members: [
    {
      member_pubkey: PUBKEY,
      lane_purpose: "merchant_lane" as const,
      subscription_state: "current" as const,
      current_tier: null,
      paid_through: null,
      last_payment_at: null,
      last_payment_amount_sats: null,
    },
  ],
  totals: { total_members: 1, by_state: {} as any },
};

const stub = vi.hoisted(() => ({
  getAdminMembers: vi.fn(),
  getContacts: vi.fn(),
  getAdminSubscriptionRevenue: vi.fn(),
  getAdminPublicAliases: vi.fn(),
  getAdminPrivateNames: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import AdminMembers from "./AdminMembers";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  stub.getAdminMembers.mockResolvedValue(MEMBERS);
  stub.getContacts.mockResolvedValue([]);
  stub.getAdminSubscriptionRevenue.mockResolvedValue({ members: [] });
  stub.getAdminPublicAliases.mockResolvedValue({ aliases: [] });
  stub.getAdminPrivateNames.mockResolvedValue({ names: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("Members page heading", () => {
  it("reads 'Members', not the capitals it was typed in", async () => {
    await act(async () => {
      root.render(React.createElement(MemoryRouter, null, React.createElement(AdminMembers)));
    });
    await act(async () => { await Promise.resolve(); });
    const h1 = host.querySelector(".admin-members-title h1");
    expect(h1).toBeTruthy();
    expect(h1!.textContent).toBe("Members");
  });
});
