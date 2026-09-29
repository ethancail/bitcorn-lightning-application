# Yahoo chart fixtures — provenance

Fixtures for `tests/daybreak/yahooCloses.test.ts` and `tests/daybreakDraftRoute.test.ts`. Each is the body of a Yahoo Finance v8 chart response (`query1.finance.yahoo.com/v8/finance/chart/<symbol>?range=…&interval=1d`), stored exactly as captured.

## How the six real captures were made — this limits what they prove

- **Fetched through Firecrawl's servers** by the claude.ai orchestrator, **not from Cloudflare**, where the adapter runs. Whether Yahoo answers the Worker's egress is unverified. This repo's own network got HTTP 429.
- **Response headers were not kept**, so there is no `Date`, `Age` or `Cache-Control`.
- **Bodies were transcribed by the orchestrator** from Firecrawl's output. The structure is reliable; any single number could be mistyped.
- Each was stored as a JSON-string `body` inside a wrapper (`requested`, `status`, `headers: null`, `capture_note`), all with `status: 200`. **Only the `body` string is stored here, verbatim.**
- **Capture time.** None of the captures records the instant it was fetched. `regularMarketTime` is Yahoo's last-trade time, so it gives only a lower bound on the fetch time.

| File | Original name | `regularMarketTime` (UTC / Central) | From its `capture_note` |
|---|---|---|---|
| `btc-usd_1mo_2026-09-28.json` | `BTC-USD_1mo.json` | 2026-09-28T18:01:14Z / Mon 13:01:14 CDT | via Firecrawl, not Cloudflare; headers not preserved; body transcribed |
| `btc-usd_5d_2026-09-28.json` | `BTC-USD_5d.json` | 2026-09-28T18:01:09Z / Mon 13:01:09 CDT | same |
| `zc-f_1mo_2026-09-28.json` | `ZC%3DF_1mo.json` | 2026-09-28T17:50:55Z / Mon 12:50:55 CDT | same |
| `zc-f_5d_2026-09-28_midday.json` | `ZC%3DF_5d.json` | 2026-09-28T17:50:41Z / Mon 12:50:41 CDT | same |
| `zc-f_5d_2026-09-28_afternoon.json` | `ZC%3DF_5d_2026-09-28_afternoon.json` | 2026-09-28T18:20:00Z / Mon 13:20:00 CDT | forced fresh fetch (`maxAge 0`); "captured after the day-session close … the day's bar is finished but still holds the LAST TRADE, 522.25; CME's settlement for DEC 26 that day was 523'0". The implementation brief relays its fetch as "~2:30 PM" Central. |
| `zc-f_5d_2026-09-29_midday.json` | `ZC%3DF_5d_2026-09-29_midday.json` | 2026-09-29T17:36:30Z / Tue 12:36:30 CDT | forced fresh fetch (`maxAge 0`); "Monday's close has been REPLACED by CME's settlement, 523.0, and Tuesday's bar is in progress; Yahoo opened it at 23:00 CDT Monday" |

Files are renamed to keep `%` (from `ZC%3DF`) out of import paths.

**Transcription oddity, unexplained:** consecutive bars repeat a volume. It happens in the 09-28 captures (09-24 and 09-25 both show 222470), and again in the 09-29 capture (09-25 and 09-28 both show 356335). The adapter reads no volume.

## SYNTHETIC fixtures — derived, not captured

Each is derived from a real capture above. `meta` is left exactly as the source's; the adapter reads only `meta.currency` from it.

| File | Derived from | Change |
|---|---|---|
| `SYNTHETIC_btc-usd_5d_plus-2026-09-29-bar.json` | `btc-usd_5d_2026-09-28.json` | A sixth bar appended at `1790640000` (2026-09-29T00:00Z), close `99999.5`, a value no real bar has (spec test 59) |
| `SYNTHETIC_zc-f_5d_fall-back-2026-11-02.json` | `zc-f_5d_2026-09-28_afternoon.json` | Timestamps only, moved to New York midnights on Wed 10-28 through Fri 10-30 (04:00Z, EDT) and **Mon 11-02 (05:00Z, EST)**. Closes unchanged (spec test 62). |
| `SYNTHETIC_zc-f_5d_spring-forward-2027-03-15.json` | `zc-f_5d_2026-09-28_afternoon.json` | Timestamps only, moved to New York midnights on Wed 03-10 through Fri 03-12 (05:00Z, EST) and **Mon 03-15 (04:00Z, EDT)**. Closes unchanged (spec test 62). |

**Also SYNTHETIC:** every `variant(...)` in `yahooCloses.test.ts`. Each is a deep copy of a real capture with one named patch: a changed or absent `currency`, a null, infinite or string close, a non-null `chart.error`, a removed field, a shortened array, or an empty series. The NaN cases are passed as an already-parsed body, because JSON cannot carry NaN.
