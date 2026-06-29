// OperatorStaking reconciliation (M9 capital-isolation vault → matcher StakeOracle feed). Mirrors
// the Settlement events/processor split: decoded stake events apply to a per-operator free/locked
// balance the Go matcher reads via the StakeOracle. Pure aside from the StakeStateWriter it drives.
//
// Free-stake reconstruction is delta-based, RE-ANCHORED by Staked.newFree (an authoritative
// post-stake snapshot) so transient drift self-heals. Balances are floored at 0 to tolerate a
// cold-start mid-history (scanning from the deploy block keeps them exact).

import type { Address, Hex } from "@dawn/shared";
import { afterCursor, type Cursor, type EventMeta } from "./events.ts";

export type StakeEvent =
  | ({ kind: "Staked"; operator: Address; amount: string; newFree: string } & EventMeta)
  | ({ kind: "Locked"; operator: Address; amount: string } & EventMeta)
  | ({ kind: "Released"; operator: Address; amount: string } & EventMeta)
  | ({ kind: "Slashed"; operator: Address; amount: string } & EventMeta)
  | ({ kind: "Withdrawn"; operator: Address; amount: string } & EventMeta)
  | ({ kind: "UnbondRequested"; operator: Address; withdrawableAt: number } & EventMeta);

/** How stake reconciliation persists per-operator balances (USDC base units, as decimal strings). */
export interface StakeStateWriter {
  /** Re-anchor free stake to the authoritative on-chain value (from Staked.newFree). */
  setFree(operator: Address, free: string): Promise<void>;
  /** Apply a signed delta to free and/or locked (e.g. Locked: free −amt, locked +amt). */
  adjust(operator: Address, freeDelta: string, lockedDelta: string): Promise<void>;
  /** Record the unbond timer; stake stays slashable until then (no balance change). */
  setWithdrawableAt(operator: Address, withdrawableAt: number): Promise<void>;
}

export interface StakeBalance {
  free: bigint;
  locked: bigint;
  withdrawableAt?: number;
}

export class InMemoryStakeStateWriter implements StakeStateWriter {
  readonly balances = new Map<Address, StakeBalance>();

  private at(op: Address): StakeBalance {
    let b = this.balances.get(op);
    if (!b) {
      b = { free: 0n, locked: 0n };
      this.balances.set(op, b);
    }
    return b;
  }
  async setFree(operator: Address, free: string): Promise<void> {
    this.at(operator).free = BigInt(free);
  }
  async adjust(operator: Address, freeDelta: string, lockedDelta: string): Promise<void> {
    const b = this.at(operator);
    b.free = max0(b.free + BigInt(freeDelta));
    b.locked = max0(b.locked + BigInt(lockedDelta));
  }
  async setWithdrawableAt(operator: Address, withdrawableAt: number): Promise<void> {
    this.at(operator).withdrawableAt = withdrawableAt;
  }
}

function max0(v: bigint): bigint {
  return v < 0n ? 0n : v;
}

/** Applies stake events to balances, idempotent past the cursor (mirrors EventProcessor). */
export class StakeProcessor {
  private cursor: Cursor | null;

  constructor(
    private readonly writer: StakeStateWriter,
    startCursor: Cursor | null = null,
  ) {
    this.cursor = startCursor;
  }

  position(): Cursor | null {
    return this.cursor;
  }

  async applyAll(events: StakeEvent[]): Promise<number> {
    let applied = 0;
    for (const e of events) {
      if (await this.apply(e)) applied++;
    }
    return applied;
  }

  async apply(e: StakeEvent): Promise<boolean> {
    if (!afterCursor(e, this.cursor)) return false;
    switch (e.kind) {
      case "Staked":
        await this.writer.setFree(e.operator, e.newFree); // authoritative snapshot
        break;
      case "Locked":
        await this.writer.adjust(e.operator, neg(e.amount), e.amount); // free → locked
        break;
      case "Released":
        await this.writer.adjust(e.operator, e.amount, neg(e.amount)); // locked → free
        break;
      case "Slashed":
        await this.writer.adjust(e.operator, "0", neg(e.amount)); // locked burned to treasury
        break;
      case "Withdrawn":
        await this.writer.adjust(e.operator, neg(e.amount), "0"); // free out (post-unbond)
        break;
      case "UnbondRequested":
        await this.writer.setWithdrawableAt(e.operator, e.withdrawableAt);
        break;
    }
    this.cursor = { blockNumber: e.blockNumber, logIndex: e.logIndex };
    return true;
  }
}

function neg(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : "-" + amount;
}

/** A stake event's on-chain key, for traceability in logs/tests. */
export function stakeEventKey(e: StakeEvent): Hex {
  return `0x${e.blockNumber.toString(16)}${e.logIndex.toString(16)}` as Hex;
}

/** Durable resume point for the stake scan (its own cursor, separate from the Settlement indexer).
 *  Distinct method names from CursorStore so one Postgres store can implement both. */
export interface StakeCursorStore {
  loadStake(): Promise<Cursor | null>;
  saveStake(cursor: Cursor): Promise<void>;
}

interface StakeSource {
  fetch(from: Cursor | null): Promise<StakeEvent[]>;
}

/** Polls an OperatorStaking log source and applies events to balances (mirror of Indexer). */
export class StakeIndexer {
  private stopped = false;

  constructor(
    private readonly source: StakeSource,
    private readonly processor: StakeProcessor,
    private readonly intervalMs = 5000,
    private readonly cursorStore?: StakeCursorStore,
  ) {}

  async tick(): Promise<number> {
    const events = await this.source.fetch(this.processor.position());
    const applied = await this.processor.applyAll(events);
    if (applied > 0 && this.cursorStore) {
      const pos = this.processor.position();
      if (pos) await this.cursorStore.saveStake(pos);
    }
    return applied;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (err) {
        console.error("stake-indexer: tick error", err);
      }
      await new Promise((r) => setTimeout(r, this.intervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
