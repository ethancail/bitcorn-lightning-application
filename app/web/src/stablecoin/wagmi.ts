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
    preference: "smartWalletOnly",
  }),
  metaMask(),
];

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
