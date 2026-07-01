// Chain + client factories for the Settlement contract.
// Centralises viem wiring so the off-chain services (proof-service, api,
// indexer) depend only on @dawn/shared/web3 and never import viem directly.

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { CHAIN_IDS, SETTLEMENT_ADDRESS, type DawnChainId } from "./addresses";
import { settlementAbi, SettlementClient } from "./client";
import { cuFor, sharedRpcBucket } from "./ratelimit";

/**
 * An http transport metered by the process-wide CU bucket: every JSON-RPC call
 * waits for its compute-unit cost before going out, so the service stays under the
 * provider's throughput cap (e.g. Alchemy free tier). On top of the proactive
 * throttle, viem's built-in retry handles any 429 that still slips through
 * (`RPC_RETRY_COUNT`, default 6). This is the single choke point for ALL Dawn RPC
 * traffic — the indexer's poll loops and the api's payment verifier alike.
 */
export function rateLimitedHttp(rpcUrl?: string): Transport {
  const retryCount = Number(process.env.RPC_RETRY_COUNT ?? 6);
  const inner = http(rpcUrl, { retryCount, retryDelay: 200, timeout: 30_000 });
  return (params) => {
    const transport = inner(params);
    const bucket = sharedRpcBucket();
    const request = (async (args: { method: string }, options?: unknown) => {
      await bucket.take(cuFor(args.method));
      return (transport.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options);
    }) as typeof transport.request;
    return { ...transport, request };
  };
}

/** Resolve the viem chain for a Dawn-supported chainId. */
export function chainFor(chainId: DawnChainId): Chain {
  switch (chainId) {
    case CHAIN_IDS.baseMainnet:
      return base;
    case CHAIN_IDS.baseSepolia:
      return baseSepolia;
    default:
      throw new Error(`unsupported chainId ${chainId as number}`);
  }
}

/** Read-only viem client type, re-exported so services need not import viem. */
export type DawnPublicClient = PublicClient;

/** A read-only client for a chain. `rpcUrl` overrides the chain's default RPC. */
export function makePublicClient(chainId: DawnChainId, rpcUrl?: string): PublicClient {
  return createPublicClient({ chain: chainFor(chainId), transport: rateLimitedHttp(rpcUrl) });
}

/** A signing client bound to `privateKey`. */
export function makeWalletClient(chainId: DawnChainId, privateKey: Hex, rpcUrl?: string): WalletClient {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: chainFor(chainId),
    transport: rateLimitedHttp(rpcUrl),
  });
}

export interface SettlementClientOptions {
  chainId: DawnChainId;
  rpcUrl?: string;
  /** Settlement address; defaults to the recorded deployment for the chain. */
  address?: Address;
  /** When set, the client can submit writes (settle/escrow/claim). */
  privateKey?: Hex;
}

/** The Ethereum address for a private key — convenience over viem/accounts. */
export function addressForPrivateKey(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}

/** Resolve the deployed Settlement address for a chain, or throw. */
export function settlementAddressFor(chainId: DawnChainId): Address {
  const addr = SETTLEMENT_ADDRESS[chainId];
  if (!addr) throw new Error(`no Settlement address recorded for chainId ${chainId}`);
  return addr;
}

/** Build a ready-to-use SettlementClient from chain + optional signing key. */
export function makeSettlementClient(opts: SettlementClientOptions): SettlementClient {
  const address = opts.address ?? settlementAddressFor(opts.chainId);
  const publicClient = makePublicClient(opts.chainId, opts.rpcUrl);
  const walletClient = opts.privateKey ? makeWalletClient(opts.chainId, opts.privateKey, opts.rpcUrl) : undefined;
  return new SettlementClient({ address, publicClient, walletClient });
}

/**
 * Decoded Settlement event as the indexer consumes it: the parsed event name +
 * args plus on-chain position. Kept viem-agnostic at the boundary so the indexer
 * never imports viem.
 */
export interface DecodedSettlementLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: number;
  logIndex: number;
  txHash: Hex;
}

/**
 * Fetch + decode Settlement logs in a block range. `address` defaults to the
 * recorded deployment. Returns events ordered by (blockNumber, logIndex).
 */
export async function fetchSettlementLogs(
  client: PublicClient,
  chainId: DawnChainId,
  fromBlock: bigint,
  toBlock: bigint,
  address?: Address,
): Promise<DecodedSettlementLog[]> {
  const logs = await client.getLogs({
    address: address ?? settlementAddressFor(chainId),
    fromBlock,
    toBlock,
  });
  const decoded = parseSettlementLogs(logs);
  return decoded
    .map((l) => ({
      eventName: l.eventName,
      args: l.args as Record<string, unknown>,
      blockNumber: Number(l.blockNumber),
      logIndex: l.logIndex,
      txHash: l.transactionHash,
    }))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

// We use parseEventLogs (not the re-exported decodeSettlementLogs) because we
// need the per-log decoded shape with block metadata, which it preserves.
function parseSettlementLogs(logs: Log[]) {
  return parseEventLogs({ abi: settlementAbi, logs });
}
