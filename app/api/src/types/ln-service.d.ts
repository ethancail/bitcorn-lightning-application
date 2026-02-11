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
    block_height?: number;
    block_hash?: string;
    synced_to_chain?: boolean;
    synced_to_graph?: boolean;
  }

  export function getWalletInfo(options: {
    lnd: any;
  }): Promise<WalletInfo>;

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
}
