// Production LogSource : polls a Base RPC for Settlement logs,
// decodes them with the Settlement ABI, and yields the indexer's SettlementEvent
// shapes strictly after the saved cursor. Block scanning is chunked and lags the
// chain head by a confirmation margin so reorgs near the tip don't surface.

import type { Address } from "@dawn/shared";
import {
  fetchSettlementLogs,
  makePublicClient,
  SettlementClient,
  SETTLEMENT_DEPLOY_BLOCK,
  settlementAddressFor,
  type DawnChainId,
  type DawnPublicClient,
  type DecodedSettlementLog,
} from "@dawn/shared/web3";
import { afterCursor, type Cursor, type SettlementEvent } from "./events.ts";
import type { LogSource } from "./source.ts";

export interface RpcLogSourceConfig {
  chainId: DawnChainId;
  rpcUrl?: string;
  /** Settlement address; defaults to the recorded deployment for the chain. */
  address?: Address;
  /** First block to scan when there is no cursor; defaults to the deploy block. */
  deployBlock?: bigint;
  /** Blocks to stay behind the head to avoid reorgs at the tip (default 2). */
  confirmations?: bigint;
  /** Max blocks per getLogs call (RPCs cap ranges; default 5000). */
  maxBlockRange?: bigint;
}

// Test seams: override how the head and logs are obtained so fetch()'s range and
// cursor logic can be exercised without a live RPC.
export interface RpcLogSourceDeps {
  client?: DawnPublicClient;
  headFn?: () => Promise<bigint>;
  logFetcher?: (fromBlock: bigint, toBlock: bigint) => Promise<DecodedSettlementLog[]>;
  treasuryFn?: () => Promise<Address>;
}

export class RpcLogSource implements LogSource {
  private readonly address: Address;
  private readonly deployBlock: bigint;
  private readonly confirmations: bigint;
  private readonly maxBlockRange: bigint;
  private readonly headFn: () => Promise<bigint>;
  private readonly logFetcher: (from: bigint, to: bigint) => Promise<DecodedSettlementLog[]>;
  private readonly treasuryFn: () => Promise<Address>;
  private treasuryCache?: Address;
  // Highest block this process has already swept (regardless of whether it yielded
  // events). Prevents re-scanning empty history every poll — see fetch().
  private scannedThrough: bigint;

  constructor(cfg: RpcLogSourceConfig, deps: RpcLogSourceDeps = {}) {
    this.address = cfg.address ?? settlementAddressFor(cfg.chainId);
    this.deployBlock = cfg.deployBlock ?? SETTLEMENT_DEPLOY_BLOCK[cfg.chainId] ?? 0n;
    this.scannedThrough = this.deployBlock - 1n;
    this.confirmations = cfg.confirmations ?? 2n;
    // Public Base RPCs cap eth_getLogs at 2000 blocks; default under that. Override
    // via INDEXER_MAX_BLOCK_RANGE / cfg for providers (Alchemy/Infura) that allow more.
    this.maxBlockRange =
      cfg.maxBlockRange ??
      (process.env.INDEXER_MAX_BLOCK_RANGE ? BigInt(process.env.INDEXER_MAX_BLOCK_RANGE) : 1000n);

    const client = deps.client ?? makePublicClient(cfg.chainId, cfg.rpcUrl);
    this.headFn = deps.headFn ?? (() => client.getBlockNumber());
    this.logFetcher =
      deps.logFetcher ?? ((from, to) => fetchSettlementLogs(client, cfg.chainId, from, to, this.address));

    const settlement = new SettlementClient({ address: this.address, publicClient: client });
    this.treasuryFn = deps.treasuryFn ?? (() => settlement.treasury());
  }

  async fetch(from: Cursor | null): Promise<SettlementEvent[]> {
    const head = await this.headFn();
    const toBlock = head - this.confirmations;
    if (toBlock < 0n) return [];

    // Resume from the cursor's block (re-scanning it, then filtering with
    // afterCursor), or the deploy block on a cold start — but never below what this
    // process has already swept. Without the scannedThrough floor the indexer
    // re-scans deploy→head every poll until the first event lands (the cursor only
    // advances on events), which is fatal when getLogs ranges are capped (Alchemy
    // free tier: 10 blocks) or billed per call. Blocks up to `toBlock` are already
    // past the confirmation margin, so skipping already-swept ones is reorg-safe.
    const cursorBlock = from ? BigInt(from.blockNumber) : this.deployBlock;
    const fromBlock = cursorBlock > this.scannedThrough ? cursorBlock : this.scannedThrough + 1n;
    if (fromBlock > toBlock) return [];

    const decoded: DecodedSettlementLog[] = [];
    for (let start = fromBlock; start <= toBlock; start += this.maxBlockRange + 1n) {
      const end = start + this.maxBlockRange <= toBlock ? start + this.maxBlockRange : toBlock;
      decoded.push(...(await this.logFetcher(start, end)));
    }
    this.scannedThrough = toBlock;

    const events: SettlementEvent[] = [];
    for (const d of decoded) {
      const ev = await this.toEvent(d);
      if (ev && afterCursor(ev, from)) events.push(ev);
    }
    return events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  }

  private async toEvent(d: DecodedSettlementLog): Promise<SettlementEvent | null> {
    if (d.eventName === "FeeCollected") {
      // The on-chain FeeCollected carries only (jobId, fee); the treasury is a
      // fixed contract config we read once and cache.
      return mapDecodedLog(d, await this.treasury());
    }
    return mapDecodedLog(d, undefined);
  }

  private async treasury(): Promise<Address> {
    if (!this.treasuryCache) this.treasuryCache = await this.treasuryFn();
    return this.treasuryCache;
  }
}

/**
 * Map a decoded Settlement log to the indexer's SettlementEvent, or null for
 * events the indexer doesn't track (bonds, consensus, proof submissions, …).
 * `treasury` is required only for FeeCollected (not emitted on-chain).
 */
export function mapDecodedLog(d: DecodedSettlementLog, treasury: Address | undefined): SettlementEvent | null {
  const meta = { blockNumber: d.blockNumber, logIndex: d.logIndex, txHash: d.txHash };
  const a = d.args;
  switch (d.eventName) {
    case "JobEscrowed":
      return {
        kind: "JobEscrowed",
        jobId: a.jobId as `0x${string}`,
        buyer: a.buyer as Address,
        amountUsdc: String(a.amount as bigint),
        deadline: Number(a.deadline as bigint),
        ...meta,
      };
    case "JobSettled":
      return {
        kind: "JobSettled",
        jobId: a.jobId as `0x${string}`,
        operator: a.operator as Address,
        amountUsdc: String(a.payout as bigint),
        feeUsdc: String(a.fee as bigint),
        ...meta,
      };
    case "JobRefunded":
      return {
        kind: "JobRefunded",
        jobId: a.jobId as `0x${string}`,
        buyer: a.buyer as Address,
        amountUsdc: String(a.amount as bigint),
        ...meta,
      };
    case "FeeCollected":
      if (!treasury) return null;
      return {
        kind: "FeeCollected",
        jobId: a.jobId as `0x${string}`,
        treasury,
        amountUsdc: String(a.fee as bigint),
        ...meta,
      };
    case "RedundantJobAuthorized":
      return {
        kind: "RedundantJobAuthorized",
        jobId: a.jobId as `0x${string}`,
        operatorSetRoot: a.operatorSetRoot as `0x${string}`,
        redundancy: Number(a.redundancy as bigint),
        bond: String(a.bond as bigint),
        nonce: Number(a.nonce as bigint),
        ...meta,
      };
    case "JobConsensus":
      return {
        kind: "JobConsensus",
        jobId: a.jobId as `0x${string}`,
        winningHash: a.winningHash as `0x${string}`,
        winners: Number(a.winners as bigint),
        rewardPerWinnerUsdc: String(a.rewardPerWinner as bigint),
        feeUsdc: String(a.fee as bigint),
        ...meta,
      };
    case "ConsensusChallenged":
      return {
        kind: "ConsensusChallenged",
        jobId: a.jobId as `0x${string}`,
        challenger: a.challenger as Address,
        ...meta,
      };
    default:
      return null;
  }
}
