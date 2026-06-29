// Production stake LogSource: polls a Base RPC for OperatorStaking logs, decodes them, and yields
// StakeEvents strictly after the saved cursor. Mirrors RpcLogSource (Settlement) — chunked scan,
// confirmation lag. Dormant until an OperatorStaking address is configured (contract not yet
// deployed; redundant flow gated).

import type { Address } from "@dawn/shared";
import {
  fetchOperatorStakingLogs,
  makePublicClient,
  type DawnChainId,
  type DawnPublicClient,
  type DecodedStakingLog,
} from "@dawn/shared/web3";
import { afterCursor, type Cursor } from "./events.ts";
import type { StakeEvent } from "./stake.ts";

export interface StakeLogSource {
  fetch(from: Cursor | null): Promise<StakeEvent[]>;
}

export interface RpcStakeSourceConfig {
  chainId: DawnChainId;
  address: Address; // OperatorStaking — required (no recorded default deployment yet)
  rpcUrl?: string;
  deployBlock?: bigint;
  confirmations?: bigint;
  maxBlockRange?: bigint;
}

export interface RpcStakeSourceDeps {
  client?: DawnPublicClient;
  headFn?: () => Promise<bigint>;
  logFetcher?: (fromBlock: bigint, toBlock: bigint) => Promise<DecodedStakingLog[]>;
}

export class RpcStakeLogSource implements StakeLogSource {
  private readonly address: Address;
  private readonly deployBlock: bigint;
  private readonly confirmations: bigint;
  private readonly maxBlockRange: bigint;
  private readonly headFn: () => Promise<bigint>;
  private readonly logFetcher: (from: bigint, to: bigint) => Promise<DecodedStakingLog[]>;

  constructor(cfg: RpcStakeSourceConfig, deps: RpcStakeSourceDeps = {}) {
    this.address = cfg.address;
    this.deployBlock = cfg.deployBlock ?? 0n;
    this.confirmations = cfg.confirmations ?? 2n;
    this.maxBlockRange =
      cfg.maxBlockRange ??
      (process.env.INDEXER_MAX_BLOCK_RANGE ? BigInt(process.env.INDEXER_MAX_BLOCK_RANGE) : 1000n);

    const client = deps.client ?? makePublicClient(cfg.chainId, cfg.rpcUrl);
    this.headFn = deps.headFn ?? (() => client.getBlockNumber());
    this.logFetcher = deps.logFetcher ?? ((from, to) => fetchOperatorStakingLogs(client, this.address, from, to));
  }

  async fetch(from: Cursor | null): Promise<StakeEvent[]> {
    const head = await this.headFn();
    const toBlock = head - this.confirmations;
    if (toBlock < 0n) return [];
    const fromBlock = from ? BigInt(from.blockNumber) : this.deployBlock;
    if (fromBlock > toBlock) return [];

    const decoded: DecodedStakingLog[] = [];
    for (let start = fromBlock; start <= toBlock; start += this.maxBlockRange + 1n) {
      const end = start + this.maxBlockRange <= toBlock ? start + this.maxBlockRange : toBlock;
      decoded.push(...(await this.logFetcher(start, end)));
    }

    const events: StakeEvent[] = [];
    for (const d of decoded) {
      const ev = mapDecodedStakeLog(d);
      if (ev && afterCursor(ev, from)) events.push(ev);
    }
    return events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  }
}

/** Map a decoded OperatorStaking log to a StakeEvent, or null for events the oracle doesn't track. */
export function mapDecodedStakeLog(d: DecodedStakingLog): StakeEvent | null {
  const meta = { blockNumber: d.blockNumber, logIndex: d.logIndex, txHash: d.txHash };
  const a = d.args;
  switch (d.eventName) {
    case "Staked":
      return {
        kind: "Staked",
        operator: a.operator as Address,
        amount: String(a.amount as bigint),
        newFree: String(a.newFree as bigint),
        ...meta,
      };
    case "Locked":
      return { kind: "Locked", operator: a.operator as Address, amount: String(a.amount as bigint), ...meta };
    case "Released":
      return { kind: "Released", operator: a.operator as Address, amount: String(a.amount as bigint), ...meta };
    case "Slashed":
      return { kind: "Slashed", operator: a.operator as Address, amount: String(a.amount as bigint), ...meta };
    case "Withdrawn":
      return { kind: "Withdrawn", operator: a.operator as Address, amount: String(a.amount as bigint), ...meta };
    case "UnbondRequested":
      return {
        kind: "UnbondRequested",
        operator: a.operator as Address,
        withdrawableAt: Number(a.withdrawableAt as bigint),
        ...meta,
      };
    default:
      return null; // SlasherSet etc. — not balance-affecting
  }
}
