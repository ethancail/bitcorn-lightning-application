// AdminMembers — Stage 5b operator surface, first cut.
//
// Source of truth:
//   bitcorn-research/specs/2026-05-20-stage-5b-admin-members-list.md
//
// Pure operational state visibility — no actions, no drill-down, no
// aggregate financial metrics (per spec §9). v1's job is "what do I
// have right now" — surfaces that generate the right questions for
// real operator use to name v2 follow-ups.
//
// Data: GET /api/admin/members (treasury-only via assertTreasury).
// Filter/sort: all client-side per spec §10.5; the dataset is small.
// Refresh: manual button + 60s auto-poll per spec §3.6.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type AdminMembersResponse,
  type AdminMembersRow,
  type LanePurpose,
  type SubscriptionStateKey,
} from "../api/client";
import { Pill, stateToPill } from "../components/Pill";

// ─── Constants ───────────────────────────────────────────────────

const POLL_INTERVAL_MS = 60_000;

const ALL_STATES: readonly SubscriptionStateKey[] = [
  "current",
  "prepay",
  "worker_lapsed",
  "routing_lapsed",
  "close_due",
  "external_peer",
  "unclassified",
  "not_yet_allocated",
  "missing",
  "no_channel",
];

const ALL_LANES: readonly LanePurpose[] = [
  "merchant_lane",
  "farmer_lane",
  "external_peer",
  "unclassified",
];

// State severity ranking per spec §3.4 (for column-header sort).
const STATE_SEVERITY: Record<SubscriptionStateKey, number> = {
  current: 0,
  prepay: 1,
  not_yet_allocated: 2,
  unclassified: 3,
  worker_lapsed: 4,
  routing_lapsed: 5,
  close_due: 6,
  missing: 7,
  external_peer: 8,
  no_channel: 9,
};

type SortColumn = "pubkey" | "lane" | "state" | "tier" | "paid_through" | "last_payment";
type SortDirection = "asc" | "desc";

type ViewState =
  | { kind: "loading" }
  | { kind: "ok"; response: AdminMembersResponse }
  | { kind: "error"; code?: string; detail?: string };

// ─── Root component ──────────────────────────────────────────────

export default function AdminMembers() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  // Filters — all selected by default (no active filter).
  const [selectedStates, setSelectedStates] = useState<Set<SubscriptionStateKey>>(
    () => new Set(ALL_STATES),
  );
  const [selectedLanes, setSelectedLanes] = useState<Set<LanePurpose>>(
    () => new Set(ALL_LANES),
  );
  const [pubkeySearch, setPubkeySearch] = useState("");

  const filtersActive =
    selectedStates.size < ALL_STATES.length ||
    selectedLanes.size < ALL_LANES.length ||
    pubkeySearch.length > 0;

  // Sort — default paid_through ASC (per spec §2.4: lapsed members
  // surface to the top of the list).
  const [sort, setSort] = useState<{ column: SortColumn; direction: SortDirection }>(
    { column: "paid_through", direction: "asc" },
  );

  const fetchMembers = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await api.getAdminMembers();
      setView({ kind: "ok", response });
    } catch (err: any) {
      setView({
        kind: "error",
        code: err?.code,
        detail: err?.detail ?? err?.message,
      });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchMembers();
    const id = setInterval(() => void fetchMembers(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchMembers]);

  return (
    <div className="admin-members-page">
      <PageHeader
        fetchedAt={view.kind === "ok" ? view.response.fetched_at : null}
        onRefresh={() => void fetchMembers()}
        refreshing={refreshing}
      />
      {view.kind === "loading" && <LoadingSkeleton />}
      {view.kind === "error" && <ErrorView code={view.code} detail={view.detail} onRetry={fetchMembers} />}
      {view.kind === "ok" && (
        <AdminMembersBody
          response={view.response}
          selectedStates={selectedStates}
          setSelectedStates={setSelectedStates}
          selectedLanes={selectedLanes}
          setSelectedLanes={setSelectedLanes}
          pubkeySearch={pubkeySearch}
          setPubkeySearch={setPubkeySearch}
          filtersActive={filtersActive}
          sort={sort}
          setSort={setSort}
        />
      )}
    </div>
  );
}

// ─── Body (composed when data loads ok) ──────────────────────────

function AdminMembersBody({
  response,
  selectedStates,
  setSelectedStates,
  selectedLanes,
  setSelectedLanes,
  pubkeySearch,
  setPubkeySearch,
  filtersActive,
  sort,
  setSort,
}: {
  response: AdminMembersResponse;
  selectedStates: Set<SubscriptionStateKey>;
  setSelectedStates: (s: Set<SubscriptionStateKey>) => void;
  selectedLanes: Set<LanePurpose>;
  setSelectedLanes: (s: Set<LanePurpose>) => void;
  pubkeySearch: string;
  setPubkeySearch: (s: string) => void;
  filtersActive: boolean;
  sort: { column: SortColumn; direction: SortDirection };
  setSort: (s: { column: SortColumn; direction: SortDirection }) => void;
}) {
  const filtered = useMemo(() => {
    return response.members.filter((row) => {
      if (!selectedStates.has(row.subscription_state)) return false;
      if (!selectedLanes.has(row.lane_purpose)) return false;
      if (pubkeySearch && !row.member_pubkey.toLowerCase().includes(pubkeySearch.toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [response.members, selectedStates, selectedLanes, pubkeySearch]);

  const sorted = useMemo(() => sortRows(filtered, sort), [filtered, sort]);

  return (
    <>
      <DistributionCounter totals={response.totals} />
      <FilterBar
        selectedStates={selectedStates}
        setSelectedStates={setSelectedStates}
        selectedLanes={selectedLanes}
        setSelectedLanes={setSelectedLanes}
        pubkeySearch={pubkeySearch}
        setPubkeySearch={setPubkeySearch}
        filtersActive={filtersActive}
        onReset={() => {
          setSelectedStates(new Set(ALL_STATES));
          setSelectedLanes(new Set(ALL_LANES));
          setPubkeySearch("");
        }}
      />
      {response.members.length === 0 ? (
        <EmptyPanel message="No members yet. The treasury has no channel peers." />
      ) : sorted.length === 0 ? (
        <EmptyPanel message="No members match the active filters." />
      ) : (
        <MembersTable rows={sorted} sort={sort} setSort={setSort} />
      )}
    </>
  );
}

// ─── Sorting ─────────────────────────────────────────────────────

function sortRows(
  rows: AdminMembersRow[],
  sort: { column: SortColumn; direction: SortDirection },
): AdminMembersRow[] {
  const dir = sort.direction === "asc" ? 1 : -1;
  const copy = [...rows];
  copy.sort((a, b) => dir * compareRows(a, b, sort.column));
  return copy;
}

function compareRows(a: AdminMembersRow, b: AdminMembersRow, column: SortColumn): number {
  switch (column) {
    case "pubkey":
      return a.member_pubkey.localeCompare(b.member_pubkey);
    case "lane":
      return a.lane_purpose.localeCompare(b.lane_purpose);
    case "state":
      return STATE_SEVERITY[a.subscription_state] - STATE_SEVERITY[b.subscription_state];
    case "tier": {
      // Non-row rows (tier=null) sort to the end regardless of direction.
      // The dir multiplier in sortRows() would flip them on desc; the
      // null-last guard here keeps non-row rows pinned to the bottom.
      if (a.current_tier === null && b.current_tier === null) return 0;
      if (a.current_tier === null) return Number.POSITIVE_INFINITY;
      if (b.current_tier === null) return Number.NEGATIVE_INFINITY;
      return STATE_SEVERITY[a.current_tier] - STATE_SEVERITY[b.current_tier];
    }
    case "paid_through":
      return compareNullableNumber(a.paid_through, b.paid_through);
    case "last_payment":
      return compareNullableNumber(a.last_payment_at, b.last_payment_at);
  }
}

// NULLS-last regardless of direction. Returning ±Infinity for nulls
// ensures the dir multiplier in sortRows can't unintentionally flip
// nulls to the top on desc — Infinity * -1 === -Infinity, but the
// caller never compares nulls to non-nulls via the dir-flipped path
// because we return the extremity once and short-circuit. Net effect:
// null values stay pinned at the end.
function compareNullableNumber(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return Number.POSITIVE_INFINITY;
  if (b === null) return Number.NEGATIVE_INFINITY;
  return a - b;
}

// ─── Sub-components ──────────────────────────────────────────────

function PageHeader({
  fetchedAt,
  onRefresh,
  refreshing,
}: {
  fetchedAt: number | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <header className="admin-members-header">
      <div className="admin-members-title">
        <span className="sub-panel-glyph" aria-hidden>◆</span>
        <h1>MEMBERS</h1>
      </div>
      <div className="admin-members-header-right">
        {fetchedAt && (
          <span className="admin-members-freshness">
            Treasury operator view — {formatDateTime(fetchedAt)}
          </span>
        )}
        <button className="sub-btn" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh now"}
        </button>
      </div>
    </header>
  );
}

function DistributionCounter({ totals }: { totals: AdminMembersResponse["totals"] }) {
  return (
    <section className="admin-members-distribution">
      <div className="admin-members-distribution-pills">
        {ALL_STATES.map((state) => {
          const pill = stateToPill(state);
          const count = totals.by_state[state] ?? 0;
          return (
            <span
              key={state}
              className={`admin-members-distribution-pill${count === 0 ? " is-zero" : ""}`}
            >
              <Pill kind={pill.kind} label={`${pill.label} ${count}`} />
            </span>
          );
        })}
      </div>
      <div className="admin-members-distribution-total">
        Total: {totals.total_members} member{totals.total_members === 1 ? "" : "s"}
      </div>
    </section>
  );
}

function FilterBar({
  selectedStates,
  setSelectedStates,
  selectedLanes,
  setSelectedLanes,
  pubkeySearch,
  setPubkeySearch,
  filtersActive,
  onReset,
}: {
  selectedStates: Set<SubscriptionStateKey>;
  setSelectedStates: (s: Set<SubscriptionStateKey>) => void;
  selectedLanes: Set<LanePurpose>;
  setSelectedLanes: (s: Set<LanePurpose>) => void;
  pubkeySearch: string;
  setPubkeySearch: (s: string) => void;
  filtersActive: boolean;
  onReset: () => void;
}) {
  return (
    <section className="admin-members-filters">
      <FilterDropdown<SubscriptionStateKey>
        label="State"
        options={ALL_STATES}
        selected={selectedStates}
        setSelected={setSelectedStates}
        formatOption={(s) => s}
      />
      <FilterDropdown<LanePurpose>
        label="Lane"
        options={ALL_LANES}
        selected={selectedLanes}
        setSelected={setSelectedLanes}
        formatOption={(l) => l}
      />
      <input
        type="text"
        className="admin-members-search"
        placeholder="Search pubkey…"
        value={pubkeySearch}
        onChange={(e) => setPubkeySearch(e.target.value)}
      />
      {filtersActive && (
        <button className="sub-link sub-link-button" onClick={onReset}>
          Reset filters
        </button>
      )}
    </section>
  );
}

function FilterDropdown<T extends string>({
  label,
  options,
  selected,
  setSelected,
  formatOption,
}: {
  label: string;
  options: readonly T[];
  selected: Set<T>;
  setSelected: (s: Set<T>) => void;
  formatOption: (opt: T) => string;
}) {
  const allSelected = selected.size === options.length;
  const summary = allSelected
    ? `${label}: all`
    : `${label}: ${selected.size}/${options.length}`;
  const toggle = (opt: T) => {
    const next = new Set(selected);
    if (next.has(opt)) next.delete(opt);
    else next.add(opt);
    setSelected(next);
  };
  return (
    <details className="admin-members-filter-dropdown">
      <summary>{summary}</summary>
      <div className="admin-members-filter-options">
        {options.map((opt) => (
          <label key={opt} className="admin-members-filter-option">
            <input
              type="checkbox"
              checked={selected.has(opt)}
              onChange={() => toggle(opt)}
            />
            <span>{formatOption(opt)}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

function MembersTable({
  rows,
  sort,
  setSort,
}: {
  rows: AdminMembersRow[];
  sort: { column: SortColumn; direction: SortDirection };
  setSort: (s: { column: SortColumn; direction: SortDirection }) => void;
}) {
  const handleSort = (column: SortColumn) => {
    if (sort.column === column) {
      setSort({ column, direction: sort.direction === "asc" ? "desc" : "asc" });
    } else {
      setSort({ column, direction: "asc" });
    }
  };
  return (
    <section className="sub-panel">
      <table className="admin-members-table">
        <thead>
          <tr>
            <SortHeader column="pubkey" sort={sort} onSort={handleSort}>Member pubkey</SortHeader>
            <SortHeader column="lane" sort={sort} onSort={handleSort}>Lane</SortHeader>
            <SortHeader column="state" sort={sort} onSort={handleSort}>State</SortHeader>
            <SortHeader column="tier" sort={sort} onSort={handleSort}>Tier</SortHeader>
            <SortHeader column="paid_through" sort={sort} onSort={handleSort}>Paid through</SortHeader>
            <SortHeader column="last_payment" sort={sort} onSort={handleSort}>Last payment</SortHeader>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <MemberRow key={row.member_pubkey} row={row} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SortHeader({
  column,
  sort,
  onSort,
  children,
}: {
  column: SortColumn;
  sort: { column: SortColumn; direction: SortDirection };
  onSort: (c: SortColumn) => void;
  children: React.ReactNode;
}) {
  const active = sort.column === column;
  const arrow = active ? (sort.direction === "asc" ? "↑" : "↓") : "";
  return (
    <th onClick={() => onSort(column)} className={`admin-sortable${active ? " is-active" : ""}`}>
      {children} <span className="admin-sort-arrow" aria-hidden>{arrow}</span>
    </th>
  );
}

function MemberRow({ row }: { row: AdminMembersRow }) {
  const pill = stateToPill(row.subscription_state);
  return (
    <tr>
      <td>
        <PubkeyCell pubkey={row.member_pubkey} />
      </td>
      <td>{formatLane(row.lane_purpose)}</td>
      <td>
        <Pill kind={pill.kind} label={pill.label} />
      </td>
      <td>{row.current_tier ?? <span className="sub-muted">—</span>}</td>
      <td>{formatPaidThrough(row.paid_through)}</td>
      <td>{formatLastPayment(row.last_payment_at, row.last_payment_amount_sats)}</td>
    </tr>
  );
}

function PubkeyCell({ pubkey }: { pubkey: string }) {
  const [copied, setCopied] = useState(false);
  const short = `${pubkey.slice(0, 8)}…${pubkey.slice(-8)}`;
  const markCopied = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const handleCopy = async () => {
    // Try the modern clipboard API first. It rejects in HTTP contexts
    // (i.e., when the operator accesses the treasury via a Tailscale
    // IP over plain HTTP rather than HTTPS or localhost) — that's the
    // expected operator workflow, so the rejection path is the common
    // one, not the exception. We catch and fall through to the legacy
    // textarea+execCommand path rather than failing silently.
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(pubkey);
        markCopied();
        return;
      } catch {
        // fall through
      }
    }
    const ta = document.createElement("textarea");
    ta.value = pubkey;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { if (document.execCommand("copy")) markCopied(); } catch { /* clipboard unavailable */ }
    document.body.removeChild(ta);
  };
  return (
    <button
      type="button"
      className="admin-members-pubkey"
      onClick={handleCopy}
      title={pubkey}
    >
      <code>{short}</code>
      {copied && <span className="admin-members-pubkey-copied">copied</span>}
    </button>
  );
}

function LoadingSkeleton() {
  return (
    <section className="sub-panel sub-panel-skeleton">
      <div className="sub-skeleton-line" style={{ width: "40%" }} />
      <div className="sub-skeleton-line" style={{ width: "60%" }} />
      <div className="sub-skeleton-line" style={{ width: "50%" }} />
      <div className="sub-skeleton-line" style={{ width: "55%" }} />
    </section>
  );
}

function EmptyPanel({ message }: { message: string }) {
  return (
    <section className="sub-panel">
      <p className="sub-body-copy">{message}</p>
    </section>
  );
}

function ErrorView({
  code,
  detail,
  onRetry,
}: {
  code?: string;
  detail?: string;
  onRetry: () => void;
}) {
  // Mirror the SubscriptionPanel's view-kind discrimination (per spec
  // §3.5 + Phase 4 spec §10 #4): transport_unreachable gets distinct
  // copy from generic infrastructure / network errors.
  const message =
    code === "treasury_unreachable"
      ? "Couldn't reach the treasury. Click Try again to retry."
      : "Couldn't load members list.";
  return (
    <section className="sub-panel">
      <div className="sub-alert sub-alert-dim-red">
        <span className="sub-alert-icon" aria-hidden>✕</span>
        <div className="sub-alert-body">
          {message}
          {detail && <span className="sub-error-detail"> ({detail})</span>}
        </div>
      </div>
      <div className="sub-actions">
        <button className="sub-btn" onClick={onRetry}>
          Try again <span aria-hidden>→</span>
        </button>
      </div>
    </section>
  );
}

// ─── Formatters ──────────────────────────────────────────────────

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatLane(lane: LanePurpose): string {
  return lane.replace(/_/g, " ");
}

function formatPaidThrough(ms: number | null): React.ReactNode {
  if (ms === null) return <span className="sub-muted">—</span>;
  const date = new Date(ms).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
  const days = Math.ceil((ms - Date.now()) / 86_400_000);
  const annotation =
    days < 0 ? `(lapsed ${-days}d ago)`
    : days === 0 ? "(today)"
    : days === 1 ? "(tomorrow)"
    : `(in ${days}d)`;
  return (
    <span>
      <code>{date}</code> <span className="sub-muted">{annotation}</span>
    </span>
  );
}

function formatLastPayment(ms: number | null, amountSats: number | null): React.ReactNode {
  if (ms === null) return <span className="sub-muted">—</span>;
  const date = new Date(ms).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
  const daysAgo = Math.floor((Date.now() - ms) / 86_400_000);
  const ago =
    daysAgo === 0 ? "(today)" : daysAgo === 1 ? "(yesterday)" : `(${daysAgo}d ago)`;
  return (
    <span>
      <code>{date}</code>{" "}
      {amountSats !== null && (
        <span className="sub-muted">— {amountSats.toLocaleString()} sats </span>
      )}
      <span className="sub-muted">{ago}</span>
    </span>
  );
}
