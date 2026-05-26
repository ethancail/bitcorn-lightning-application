// RailScope — narrowly-scoped WagmiProvider + QueryClientProvider wrapper.
//
// Wraps only the stablecoin routes so the rest of Bitcorn's UI doesn't
// pay the wagmi bundle cost on every render path. The wagmi config is
// constructed once at module load (see ./wagmi.ts); the QueryClient is
// instantiated once per scope mount (acceptable for v1 — re-mounts on
// route changes are rare and cheap).
//
// If/when other surfaces need wagmi (e.g., a future v2 buy-USDC button
// outside the rail), promote this to a top-level provider in App.tsx.

import { useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "./wagmi";

export function RailScope({ children }: { children: React.ReactNode }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
