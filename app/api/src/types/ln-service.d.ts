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
}
