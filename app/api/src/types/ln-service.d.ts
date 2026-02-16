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
  }

  export function getChannels(options: {
    lnd: any;
  }): Promise<{ channels: Channel[] }>;

  export function payViaPaymentRequest(options: {
    lnd: any;
    request: string;
  }): Promise<{
    id: string;
    tokens: number;
    fee: number;
    confirmed_at?: string;
  }>;

  export function decodePaymentRequest(options: {
    request: string;
  }): {
    id: string;
    destination: string;
    tokens: number;
  };

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

  export function updateRoutingFees(args: {
    lnd: any;
    base_fee_mtokens?: string;
    fee_rate?: number;
  }): Promise<{ failures?: Array<{ failure: string }> }>;

  export function getChainBalance(options: {
    lnd: any;
  }): Promise<{ chain_balance: number }>;

  export function addPeer(options: {
    lnd: any;
    public_key: string;
    socket?: string;
    timeout?: number;
  }): Promise<void>;

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
}
