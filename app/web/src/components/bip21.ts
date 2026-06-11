// BIP-21 URI builder, extracted from SubscriptionPanel so it can be
// unit-tested and shared by the pay-from-node modal's "I have BTC
// elsewhere" path.
//
// Casing matters: BIP-21 query keys are case-sensitive. The deposit-QR
// component uppercases its input for QR alphanumeric-mode efficiency,
// which would turn `?amount=` into `?AMOUNT=` and break wallet parsers.
// Anchors must use THIS lowercase output directly, never the QR string.
//
// The amount is rendered with 8 decimals: `bitcoin:<addr>?amount=0.00050000`
// — equivalent to 0.0005 BTC per BIP-21, but fixed-precision so it reads
// consistently.
export function bip21Uri(address: string, amountSats: number): string {
  const btc = (amountSats / 1e8).toFixed(8);
  return `bitcoin:${address}?amount=${btc}`;
}
