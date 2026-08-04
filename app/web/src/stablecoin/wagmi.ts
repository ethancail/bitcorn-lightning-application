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

// ⚠ SECURE CONTEXT: MEASURED, NOT INFERRED — Coinbase cannot connect over plain HTTP.
//
// 2026-08-04, Chrome 151, plain-HTTP non-localhost origin (LAN + Tailscale IP):
// window.isSecureContext === false, and BOTH crypto.subtle and crypto.randomUUID
// are undefined. Control: crypto.getRandomValues stays defined, so this is the
// secure-context gate and not a broken crypto stack. Same server at localhost
// reports isSecureContext true with all three present — so TESTING AT LOCALHOST
// GIVES A FALSE PASS.
//
// This SDK calls both gated APIs unguarded from the DAPP origin (15 sites) and has
// no isSecureContext check, so it fails with an opaque TypeError rather than a
// diagnosable refusal. Driving the real SDK: createCoinbaseWalletSDK and
// getProvider() both succeed, then request({method:"eth_requestAccounts"}) throws
// `TypeError: crypto.randomUUID is not a function` at CoinbaseWalletProvider.request
// — before any popup opens.
//
// HOW THAT STRING REACHED A FARMER: WalletRegistrationPanel's connect catch is
// `e.detail ?? e.shortMessage ?? e.message`, so the raw TypeError message rendered
// straight into the red alert. That is the surface the gate protects.
//
// preference "all" does NOT rescue it: both signer types need the same crypto in
// this origin (scw via util/cipher.js, walletlink via WalletLinkCipher.js), and
// sign/util.js shows those are the only two. It stays "all" because it is correct
// for the HTTPS case.
//
// THE RECONNECT PATH IS ALSO REACHABLE, AND IS ALREADY HARMLESS — worth writing
// down because whoever finds it next will want to guard it. WagmiProvider defaults
// reconnectOnMount to true and RailScope does not override it, so on every member
// page load wagmi retries the connector persisted in localStorage; for Coinbase
// that calls isAuthorized() -> getAccounts() -> provider.request() -> the same
// throw, with no click at all. But it is swallowed four layers deep: the
// connector's own try/catch in isAuthorized returns false, and wagmi's reconnect
// wraps getProvider and connect in .catch(). The observable effect is a persisted
// session silently failing to reconnect — correct behaviour on an insecure origin.
// DO NOT set reconnectOnMount={false} to "fix" it: that would break legitimate
// HTTPS reconnection in exchange for nothing.
//
// An earlier note here reasoned that the keys.coinbase.com popup is its own HTTPS
// origin so plain HTTP might be survivable. That was right about the passkey
// ceremony (navigator.credentials: 0 dapp-side call sites) and wrong about the
// outcome — the encrypted dapp<->popup channel and the popup's window id need
// secure-context crypto HERE.
//
// Umbrel serves this app over plain HTTP on a LAN host (umbrel-app.yml port 3200),
// so this is the stock member-node condition. UPSTREAM FIX IS HTTPS FOR THE MEMBER
// UI; until then the picker gates the Coinbase tile on window.isSecureContext
// (secureContext.ts) and MetaMask carries the recommendation.

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
