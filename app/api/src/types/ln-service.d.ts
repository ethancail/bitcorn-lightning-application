// Type declarations for ln-service
declare module "ln-service" {
  export interface AuthenticatedLndGrpc {
    lnd: any;
    logger: any;
  }

  export function authenticatedLndGrpc(options: {
    cert: string;
    macaroon: string;
    socket: string;
    tls?: {
      rejectUnauthorized?: boolean;
    };
  }): AuthenticatedLndGrpc;

  export interface WalletInfo {
    public_key?: string;
    alias?: string;
    version?: string;
    active_channels_count?: number;
    peers_count?: number;
    current_block_height?: number;
    block_hash?: string;
    is_synced_to_chain?: boolean;
    is_synced_to_graph?: boolean;
    features?: Array<{
      bit: number;
      is_known: boolean;
      is_required: boolean;
      type: string;
    }>;
  }

  export function getWalletInfo(options: {
    lnd: any;
  }): Promise<WalletInfo>;

  export function getHeight(options: {
    lnd: any;
  }): Promise<{ current_block_height: number }>;

  export interface Identity {
    public_key: string;
  }

  export function getIdentity(options: {
    lnd: any;
  }): Promise<Identity>;

  // 👇 ADD THESE
  export interface Peer {
    public_key: string;
    socket?: string;
    address?: string;
    bytes_sent?: number;
    bytes_received?: number;
    ping_time?: number;
  }

  export function getPeers(options: {
    lnd: any;
  }): Promise<{ peers: Peer[] }>;

  export interface Channel {
    id: string;
    partner_public_key: string;
    capacity: number;
    local_balance: number;
    remote_balance: number;
    is_active: boolean;
    is_private?: boolean;
    transaction_id: string;
    transaction_vout: number;
  }

  export function getChannels(options: {
    lnd: any;
  }): Promise<{ channels: Channel[] }>;

  export function payViaPaymentRequest(options: {
    lnd: any;
    request: string;
    outgoing_channel?: string;
  }): Promise<{
    id: string;
    tokens: number;
    fee: number;
    confirmed_at?: string;
  }>;

  export function decodePaymentRequest(options: {
    lnd: any;
    request: string;
  }): Promise<{
    id: string;
    destination: string;
    tokens: number;
    description?: string;
    expires_at?: string;
  }>;

  export interface Invoice {
    id: string;
    received?: number;
    is_confirmed?: boolean;
    confirmed_at?: string;
  }

  export function getInvoices(options: {
    lnd: any;
  }): Promise<{ invoices: Invoice[] }>;

  export interface Forward {
    created_at: string;
    fee: number;
    fee_mtokens?: string;
    incoming_channel: string;
    mtokens?: string;
    outgoing_channel: string;
    tokens: number;
  }

  export function getForwards(options: {
    lnd: any;
    after?: string;
    before?: string;
    limit?: number;
    token?: string;
  }): Promise<{ forwards: Forward[]; next?: string }>;

  export function closeChannel(args: {
    lnd: any;
    transaction_id: string;
    transaction_vout: number;
    is_force_close?: boolean;
    tokens_per_vbyte?: number; // chain fee rate for cooperative close
  }): Promise<{ transaction_id?: string }>;

  export function updateRoutingFees(args: {
    lnd: any;
    base_fee_mtokens?: string;
    fee_rate?: number;
    transaction_id?: string;
    transaction_vout?: number;
  }): Promise<{ failures?: Array<{ failure: string }> }>;

  export function getChainBalance(options: {
    lnd: any;
  }): Promise<{ chain_balance: number }>;

  export function getPendingChainBalance(options: {
    lnd: any;
  }): Promise<{ pending_chain_balance: number }>;

  export interface ChainTransaction {
    block_id?: string;
    confirmation_count?: number;
    confirmation_height?: number;
    created_at: string;
    description?: string;
    fee?: number;
    id: string;
    is_confirmed: boolean;
    is_outgoing: boolean;
    output_addresses: string[];
    tokens: number;
  }

  export function getChainTransactions(options: {
    lnd: any;
    after?: number;
    before?: number;
  }): Promise<{ transactions: ChainTransaction[] }>;

  export interface ChainUtxo {
    address: string;
    address_format: string;
    confirmation_count: number;
    output_script: string;
    tokens: number;
    transaction_id: string;
    transaction_vout: number;
  }

  export function getUtxos(options: {
    lnd: any;
    min_confirmations?: number;
    max_confirmations?: number;
  }): Promise<{ utxos: ChainUtxo[] }>;

  export function addPeer(options: {
    lnd: any;
    public_key: string;
    socket?: string;
    timeout?: number;
  }): Promise<void>;

  export function signMessage(options: {
    lnd: any;
    message: string;
  }): Promise<{ signature: string }>;

  export function verifyMessage(options: {
    lnd: any;
    message: string;
    signature: string;
  }): Promise<{ signed_by: string }>;

  export function openChannel(options: {
    lnd: any;
    partner_public_key: string;
    local_tokens: number;
    is_private?: boolean;
    chain_fee_tokens_per_vbyte?: number;
    min_confirmations?: number;
    partner_socket?: string;
  }): Promise<{
    transaction_id: string;
    transaction_vout: number;
  }>;

  export interface PendingChannel {
    capacity: number;
    is_opening?: boolean;
    is_closing?: boolean;
    partner_public_key: string;
  }

  export function getPendingChannels(options: {
    lnd: any;
  }): Promise<{ pending_channels: PendingChannel[] }>;

  export function createInvoice(options: {
    lnd: any;
    tokens?: number;
    mtokens?: string;
    description?: string;
  }): Promise<{
    id: string;
    request: string;
    secret: string;
    tokens?: number;
    mtokens?: string;
    payment?: string;
  }>;

  export interface RouteHop {
    channel: string;
    public_key: string;
    forward: number;
    fee: number;
    timeout: number;
  }

  export interface Route {
    fee: number;
    fee_mtokens?: string;
    hops: RouteHop[];
    tokens: number;
    timeout: number;
  }

  export function getRouteToDestination(options: {
    lnd: any;
    destination: string;
    tokens: number;
    outgoing_channel?: string;
    incoming_peer?: string;
    max_fee?: number;
    payment?: string;
    total_mtokens?: string;
    start?: string; // source pubkey — probe route FROM this node (uses gossip graph)
  }): Promise<{ route: Route }>;

  export function payViaRoutes(options: {
    lnd: any;
    id: string;
    routes: Route[];
  }): Promise<{
    fee: number;
    tokens: number;
    secret: string;
    id: string;
    is_confirmed: boolean;
  }>;

  export function payViaPaymentDetails(options: {
    lnd: any;
    destination: string;
    tokens: number;
    id?: string;
    max_fee?: number;
    outgoing_channel?: string;
    features?: { type: number; is_required?: boolean }[];
    messages?: { type: string; value: string }[];
  }): Promise<{
    fee: number;
    fee_mtokens: string;
    id: string;
    is_confirmed: boolean;
    tokens: number;
    secret: string;
  }>;

  export function getNode(options: {
    lnd: any;
    public_key: string;
    is_omitting_channels?: boolean;
  }): Promise<{ alias: string; color: string; updated_at: string }>;

  export function createChainAddress(options: {
    lnd: any;
    format: 'p2wpkh' | 'np2wpkh' | 'p2tr';
    is_unused?: boolean;
  }): Promise<{ address: string }>;

  // Transcribed verbatim from the `lightning` package typedefs
  // (lnd_methods/onchain/send_to_chain_address.d.ts and
  // .../get_chain_fee_rate.d.ts), which ln-service@58 re-exports.
  // Both are ASYNC and require `lnd`. Declaring them locally from
  // memory is how the decodePaymentRequest production bug happened —
  // these match the library's own signatures. Two foot-guns the
  // upstream types make explicit and a hand-written declaration would
  // get wrong:
  //   - sendToChainAddress returns the txid as `id`, NOT `txid`.
  //   - getChainFeeRate takes `confirmation_target` (NOT
  //     `target_confirmations`) and returns a per-vByte RATE, not a
  //     total fee.
  // Narrowed to the fields we actually use; full upstream surface is
  // larger (utxo_selection, is_send_all, wss/log, etc.).
  export function sendToChainAddress(options: {
    lnd: any;
    address: string;
    tokens: number;
    target_confirmations?: number;
    fee_tokens_per_vbyte?: number;
    description?: string;
  }): Promise<{
    id: string; // transaction id hex (the txid)
    confirmation_count: number;
    is_confirmed: boolean;
    is_outgoing: boolean;
    tokens: number;
  }>;

  export function getChainFeeRate(options: {
    lnd: any;
    confirmation_target?: number;
  }): Promise<{ tokens_per_vbyte: number }>;

  // Updates the node alias advertised in the graph (BOLT 7 node_announcement).
  // Re-exported by ln-service@58 from the `lightning` package
  // (lnd_methods/peers/update_alias.js). Library validates only that
  // `alias !== undefined` (empty string passes the library but LND rejects it
  // as a no-op — see lnd.ts updateNodeAlias). Requires the `peersrpc` build tag
  // and `peers:write` permission; unsupported on LND <= 0.14.5. Resolves with no
  // value.
  export function updateAlias(options: {
    lnd: any;
    alias: string;
  }): Promise<void>;
}
