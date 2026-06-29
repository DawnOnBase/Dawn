// Decoded Settlement events . Field
// shapes mirror the on-chain events; the actual ABI/topic decoding lives behind
// the LogSource so this module stays decode-agnostic and testable.

import type { Address, Hex } from "@dawn/shared";

export interface EventMeta {
  blockNumber: number;
  logIndex: number;
  txHash: Hex;
}

export type SettlementEvent =
  | ({ kind: "JobEscrowed"; jobId: Hex; buyer: Address; amountUsdc: string; deadline: number } & EventMeta)
  | ({ kind: "JobSettled"; jobId: Hex; operator: Address; amountUsdc: string; feeUsdc: string } & EventMeta)
  | ({ kind: "JobRefunded"; jobId: Hex; buyer: Address; amountUsdc: string } & EventMeta)
  | ({ kind: "FeeCollected"; jobId: Hex; treasury: Address; amountUsdc: string } & EventMeta)
  // --- M9 redundant-execution events (the redundant-execution design). ---
  | ({
      kind: "RedundantJobAuthorized";
      jobId: Hex;
      operatorSetRoot: Hex;
      redundancy: number;
      bond: string;
      nonce: number;
    } & EventMeta)
  | ({
      kind: "JobConsensus";
      jobId: Hex;
      winningHash: Hex;
      winners: number;
      rewardPerWinnerUsdc: string;
      feeUsdc: string;
    } & EventMeta)
  | ({ kind: "ConsensusChallenged"; jobId: Hex; challenger: Address } & EventMeta);

/** A monotonic cursor position, used for idempotent resume. */
export interface Cursor {
  blockNumber: number;
  logIndex: number;
}

export function afterCursor(e: EventMeta, c: Cursor | null): boolean {
  if (!c) return true;
  if (e.blockNumber !== c.blockNumber) return e.blockNumber > c.blockNumber;
  return e.logIndex > c.logIndex;
}
