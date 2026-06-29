// EventProcessor applies decoded Settlement events to job state (the architecture
//). It is idempotent: events at or before the persisted cursor are
// skipped, so replays/restarts don't double-apply. Pure aside from the
// JobStateWriter it drives — fully unit-tested.

import { JobStatus } from "@dawn/shared";
import { afterCursor, type Cursor, type SettlementEvent } from "./events.ts";
import type { JobStateWriter } from "./state.ts";

export class EventProcessor {
  private cursor: Cursor | null;

  constructor(
    private readonly writer: JobStateWriter,
    startCursor: Cursor | null = null,
  ) {
    this.cursor = startCursor;
  }

  position(): Cursor | null {
    return this.cursor;
  }

  /** Apply a batch in order, returning how many were newly applied. */
  async applyAll(events: SettlementEvent[]): Promise<number> {
    let applied = 0;
    for (const e of events) {
      if (await this.apply(e)) applied++;
    }
    return applied;
  }

  /** Apply one event; returns false if it was already past the cursor (skipped). */
  async apply(e: SettlementEvent): Promise<boolean> {
    if (!afterCursor(e, this.cursor)) return false;

    switch (e.kind) {
      case "JobEscrowed":
        await this.writer.setStatus(e.jobId, JobStatus.Escrowed);
        break;
      case "JobSettled":
        await this.writer.recordSettlement(e.jobId, e.operator, e.amountUsdc, e.feeUsdc);
        await this.writer.setStatus(e.jobId, JobStatus.Settled);
        break;
      case "JobRefunded":
        // Escrow returned to buyer => the job ended without a valid completion.
        await this.writer.setStatus(e.jobId, JobStatus.Failed);
        break;
      case "FeeCollected":
        await this.writer.recordFee(e.jobId, e.treasury, e.amountUsdc);
        break;
      case "RedundantJobAuthorized":
        // Committee authorization rides alongside JobEscrowed (same tx). Persist the on-chain
        // committee facts; status stays driven by JobEscrowed (M0 D4).
        await this.writer.recordRedundantAuthorization(e.jobId, e.operatorSetRoot, e.redundancy, e.bond, e.nonce);
        break;
      case "JobConsensus":
        // Super-plurality frozen on-chain (PendingConsensus). Off-chain we mark it proven — the
        // payout finalizes after the challenge window via claim → JobSettled.
        await this.writer.setStatus(e.jobId, JobStatus.Proven);
        break;
      case "ConsensusChallenged":
        // A challenge voids consensus → refund/re-run; the job did not complete validly.
        await this.writer.setStatus(e.jobId, JobStatus.Failed);
        break;
    }

    this.cursor = { blockNumber: e.blockNumber, logIndex: e.logIndex };
    return true;
  }
}
