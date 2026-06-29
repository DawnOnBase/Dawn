// JobStateWriter is how the indexer reconciles on-chain truth into the shared
// jobs table . In production this is a Postgres writer updating
// the same table the API and job-queue use; an in-memory impl backs tests.

import type { Address, Hex, JobStatus } from "@dawn/shared";

export interface JobStateWriter {
  // Set a job's status (chain is authoritative for escrow/settle/refund).
  setStatus(jobId: Hex, status: JobStatus): Promise<void>;
  // Record settlement payout + operator for reconciliation/accounting.
  recordSettlement(jobId: Hex, operator: Address, amountUsdc: string, feeUsdc: string): Promise<void>;
  // Accrue protocol fees to treasury accounting.
  recordFee(jobId: Hex, treasury: Address, amountUsdc: string): Promise<void>;
  // Record the orchestrator-authorized committee for a redundant job (M9). Persists the on-chain
  // operatorSetRoot/redundancy/bond/nonce so the backend + watchtower can reconcile against chain.
  // Does NOT change status — JobEscrowed remains the only thing that flips a job to escrowed (M0 D4).
  recordRedundantAuthorization(
    jobId: Hex,
    operatorSetRoot: Hex,
    redundancy: number,
    bond: string,
    nonce: number,
  ): Promise<void>;
}

export interface JobSettlementRecord {
  status: JobStatus;
  operator?: Address;
  amountUsdc?: string;
  feeUsdc?: string;
}

export interface RedundantAuthRecord {
  operatorSetRoot: Hex;
  redundancy: number;
  bond: string;
  nonce: number;
}

export class InMemoryJobStateWriter implements JobStateWriter {
  readonly status = new Map<Hex, JobStatus>();
  readonly settlements = new Map<Hex, JobSettlementRecord>();
  readonly fees = new Map<Hex, { treasury: Address; amountUsdc: string }>();
  readonly redundantAuth = new Map<Hex, RedundantAuthRecord>();

  async setStatus(jobId: Hex, status: JobStatus): Promise<void> {
    this.status.set(jobId, status);
    const rec = this.settlements.get(jobId);
    if (rec) rec.status = status;
  }
  async recordSettlement(jobId: Hex, operator: Address, amountUsdc: string, feeUsdc: string): Promise<void> {
    this.settlements.set(jobId, { status: this.status.get(jobId) ?? ("settled" as JobStatus), operator, amountUsdc, feeUsdc });
  }
  async recordFee(jobId: Hex, treasury: Address, amountUsdc: string): Promise<void> {
    this.fees.set(jobId, { treasury, amountUsdc });
  }
  async recordRedundantAuthorization(
    jobId: Hex,
    operatorSetRoot: Hex,
    redundancy: number,
    bond: string,
    nonce: number,
  ): Promise<void> {
    this.redundantAuth.set(jobId, { operatorSetRoot, redundancy, bond, nonce });
  }
}
