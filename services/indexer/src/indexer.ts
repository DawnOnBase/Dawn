// Indexer polls the LogSource and feeds new events to the EventProcessor
// . `tick()` is one poll cycle (testable); `run()` loops it.

import type { Cursor } from "./events.ts";
import type { EventProcessor } from "./processor.ts";
import type { LogSource } from "./source.ts";

/** Durable cursor persistence so restarts resume instead of re-scanning. */
export interface CursorStore {
  load(): Promise<Cursor | null>;
  save(cursor: Cursor): Promise<void>;
}

export class Indexer {
  private stopped = false;

  constructor(
    private readonly source: LogSource,
    private readonly processor: EventProcessor,
    private readonly intervalMs = 5000,
    private readonly cursorStore?: CursorStore,
  ) {}

  /** One poll cycle: fetch events after the cursor, apply them, persist the cursor. */
  async tick(): Promise<number> {
    const events = await this.source.fetch(this.processor.position());
    const applied = await this.processor.applyAll(events);
    if (applied > 0 && this.cursorStore) {
      const pos = this.processor.position();
      if (pos) await this.cursorStore.save(pos);
    }
    return applied;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (err) {
        console.error("indexer: tick error", err);
      }
      await sleep(this.intervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
