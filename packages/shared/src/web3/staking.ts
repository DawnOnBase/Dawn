// OperatorStaking client + log decoding (M9 capital-isolation vault). Mirrors the Settlement
// client/rpc helpers so the indexer can reconcile stake balances feeding the matcher's
// StakeOracle, without importing viem directly. Reads need a publicClient.

import { parseEventLogs, type Abi, type Address, type Hex, type PublicClient } from "viem";
import stakingAbiJson from "../../abi/OperatorStaking.json" with { type: "json" };

export const operatorStakingAbi = stakingAbiJson as Abi;

export interface OperatorStakingClientConfig {
  address: Address;
  publicClient: PublicClient;
}

/** Read-only OperatorStaking client — the indexer uses this to re-anchor a stake balance on-chain. */
export class OperatorStakingClient {
  readonly address: Address;
  private readonly pub: PublicClient;

  constructor(cfg: OperatorStakingClientConfig) {
    this.address = cfg.address;
    this.pub = cfg.publicClient;
  }

  /** Operator's free (lockable / withdrawable-after-unbond) stake, USDC base units. */
  async freeStake(operator: Address): Promise<bigint> {
    return (await this.read("freeStake", [operator])) as bigint;
  }

  /** Operator's currently-locked bond total, USDC base units. */
  async lockedStake(operator: Address): Promise<bigint> {
    return (await this.read("lockedStake", [operator])) as bigint;
  }

  private read(functionName: string, args: readonly unknown[]): Promise<unknown> {
    return this.pub.readContract({ address: this.address, abi: operatorStakingAbi, functionName, args });
  }
}

/**
 * Decoded OperatorStaking event as the indexer consumes it (viem-agnostic at the boundary, like
 * DecodedSettlementLog).
 */
export interface DecodedStakingLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: number;
  logIndex: number;
  txHash: Hex;
}

/** Fetch + decode OperatorStaking logs in a block range, ordered by (blockNumber, logIndex). */
export async function fetchOperatorStakingLogs(
  client: PublicClient,
  address: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<DecodedStakingLog[]> {
  const logs = await client.getLogs({ address, fromBlock, toBlock });
  return parseEventLogs({ abi: operatorStakingAbi, logs })
    .map((l) => ({
      eventName: (l as { eventName: string }).eventName,
      args: (l as { args: Record<string, unknown> }).args,
      blockNumber: Number((l as { blockNumber: bigint }).blockNumber),
      logIndex: (l as { logIndex: number }).logIndex,
      txHash: (l as { transactionHash: Hex }).transactionHash,
    }))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}
