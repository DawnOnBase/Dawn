// LogSource yields decoded Settlement events from a starting cursor (the architecture
//). Production impl polls a Base RPC and decodes logs with the Settlement
// ABI (shared with the agent,). ArrayLogSource backs tests.

import type { Cursor, SettlementEvent } from "./events.ts";

export interface LogSource {
  // Fetch events strictly after `from` (null = from genesis/deploy block).
  fetch(from: Cursor | null): Promise<SettlementEvent[]>;
}

export class ArrayLogSource implements LogSource {
  constructor(private readonly events: SettlementEvent[]) {}
  async fetch(from: Cursor | null): Promise<SettlementEvent[]> {
    return this.events
      .filter((e) => {
        if (!from) return true;
        if (e.blockNumber !== from.blockNumber) return e.blockNumber > from.blockNumber;
        return e.logIndex > from.logIndex;
      })
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  }
}
