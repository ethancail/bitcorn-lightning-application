// Wagmi v2 configuration for the stablecoin rail.
//
// Three connectors per spec amendment §1 (the wallet picker's three
// stacked options):
//   - Coinbase Smart Wallet (top, "Recommended — no seed phrase")
//   - MetaMask (middle)
//   - "Other wallet" via WalletConnect v2 (bottom)
//
// Chain coverage: Base Sepolia (84532) for the Phase 1 contract deployment;
// Base mainnet (8453) included so a v2 mainnet migration doesn't require
// re-configuring wagmi. The default chain is read from VITE_BASE_CHAIN_ID
// (defaults to Base Sepolia 84532 — matches handlers.ts readChainId()).
//
// WalletConnect projectId is read from VITE_WALLETCONNECT_PROJECT_ID. When
// absent, the WalletConnect connector is omitted entirely and the wallet
// picker's "Other wallet" tile renders as disabled-with-config-hint rather
// than offering a broken modal. Future deltas: wire this through the
// existing Cloudflare Worker's secrets-fetch path if we want to avoid
// shipping the projectId in the frontend bundle (it's a public ID by
// design, so static config is acceptable for v1).

import { http, createConfig } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { coinbaseWallet, metaMask, walletConnect } from "wagmi/connectors";

const WC_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as
  | string
  | undefined;

const RAW_CHAIN_ID = import.meta.env.VITE_BASE_CHAIN_ID as string | undefined;
const DEFAULT_CHAIN_ID = RAW_CHAIN_ID ? Number(RAW_CHAIN_ID) : 84532;

export const isWalletConnectConfigured = !!WC_PROJECT_ID;

const baseConnectors = [
  coinbaseWallet({
    appName: "Bitcorn Lightning",
    // "all", NOT "smartWalletOnly" — offer the passkey Smart Wallet AND an
    // existing Coinbase Wallet (EOA). This is one connector either way
    // (id: "coinbaseWalletSDK"); the choice is presented inside Coinbase's own
    // popup at keys.coinbase.com, so the tile list here does not change.
    //
    // WHY IT MATTERS RATHER THAN JUST BEING MORE GENEROUS: an EOA verifies
    // locally, a Smart Wallet needs an ERC-1271 on-chain read. "all" means the
    // Coinbase tile has a branch that works even if the on-chain read cannot.
    preference: "all",
  }),
  metaMask(),
];

// ⚠ RECORDED RISK — SECURE CONTEXT, and it is untested in a browser.
//
// Umbrel serves this app over PLAIN HTTP on a LAN host (umbrel-app.yml `port:
// 3200`), so the page origin is typically http://umbrel.local:3200 or
// http://<lan-ip>:3200 — NOT a secure context. Passkeys (WebAuthn) require one,
// and this repo has already been bitten by exactly that class of thing:
// navigator.clipboard fails silently on plain HTTP (see CLAUDE.md "Hard-Won
// Gotchas").
//
// THE ANALYSIS, so nobody has to re-derive it: this is probably NOT fatal. The
// passkey ceremony does not run on this origin — it runs inside the
// Coinbase-hosted popup at https://keys.coinbase.com/connect (the SDK's default
// Preference.keysUrl), which is its own HTTPS origin and therefore its own
// secure context. That keys-popup architecture exists precisely so dapps on
// arbitrary origins can use passkeys.
//
// ⚠ INFERRED FROM THE SDK AND PLATFORM RULES — NOT VERIFIED IN A BROWSER. What
// could still bite: popup blocking, and postMessage across an insecure opener →
// secure popup boundary.
//
// WHAT TURNS ON IT: if passkey creation does fail here, then "create a new
// wallet with no seed phrase" is a pitch that does not work for the audience it
// is aimed at, and the tile's copy and `recommended` badge should change. Note
// a farmer can still create a Smart Wallet ELSEWHERE (Coinbase's own site,
// another dapp) and connect it here — the popup handles auth, not just creation
// — so ERC-1271 verification gets exercised regardless. The code above is
// correct either way; only the copy depends on the answer.
//
// TO SETTLE IT: one manual Coinbase connect from a member node's LAN URL.

const connectors = WC_PROJECT_ID
  ? [
      ...baseConnectors,
      walletConnect({
        projectId: WC_PROJECT_ID,
        metadata: {
          name: "Bitcorn Lightning",
          description: "Lightning Treasury — Stablecoin Settlements",
          url: typeof window !== "undefined" ? window.location.origin : "",
          icons: [],
        },
        showQrModal: true,
      }),
    ]
  : baseConnectors;

export const wagmiConfig = createConfig({
  chains: [baseSepolia, base],
  connectors,
  transports: {
    [baseSepolia.id]: http(),
    [base.id]: http(),
  },
  ssr: false,
});

export const DEFAULT_CHAIN = DEFAULT_CHAIN_ID === base.id ? base : baseSepolia;
