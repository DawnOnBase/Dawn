// Lightweight viem client for the Settlement contract .
// Used by the agent Payout Manager [S] (settle/claim) and the backend indexer [P]
// (event decoding). Reads need a publicClient; writes additionally need a walletClient.

import {
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from "viem";
import settlementAbiJson from "../../abi/Settlement.json" with { type: "json" };
import type { ProofBundle } from "../types";

export const settlementAbi = settlementAbiJson as Abi;

/** On-chain JobStatus enum (Settlement.sol). Distinct from the off-chain lifecycle `JobStatus`. */
export enum OnchainJobStatus {
  None = 0,
  Escrowed = 1,
  Settled = 2,
  Refunded = 3,
  // M9 redundant flow (appended; ordinals stable):
  PendingConsensus = 4, // super-plurality reached; in the challenge window before payout
  Challenged = 5, // consensus voided; escrow refundable, bonds returned
}

/** Mirrors `ISettlement.RedundantEscrow` — the orchestrator-signed escrow tuple (M9). Field order
 *  matches the contract's `_ASSIGNMENT_TYPEHASH`; viem encodes it as the `escrowRedundant` tuple. */
export interface RedundantEscrow {
  jobId: Hex;
  amount: bigint;
  deadline: bigint; // uint64
  redundancy: number; // uint16
  bond: bigint;
  inputHash: Hex;
  operatorSetRoot: Hex;
  nonce: bigint;
}

export interface SettlementClientConfig {
  address: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient;
}

export class SettlementClient {
  readonly address: Address;
  private readonly pub: PublicClient;
  private readonly wallet?: WalletClient;

  constructor(cfg: SettlementClientConfig) {
    this.address = cfg.address;
    this.pub = cfg.publicClient;
    this.wallet = cfg.walletClient;
  }

  // --- reads ---

  async jobStatus(jobId: Hex): Promise<OnchainJobStatus> {
    return (await this.read("jobStatus", [jobId])) as OnchainJobStatus;
  }

  /** The protocol fee sink (the `treasury` address recorded on-chain). */
  async treasury(): Promise<Address> {
    return (await this.read("treasury", [])) as Address;
  }

  /** The orchestrator (M9) key authorized to sign committee Assignments (zero if unconfigured). */
  async orchestrator(): Promise<Address> {
    return (await this.read("orchestrator", [])) as Address;
  }

  /** On-chain EIP-712 digest; cross-check against the local `proofDigest` helper. */
  async proofDigest(proof: ProofBundle): Promise<Hex> {
    return (await this.read("proofDigest", [proof])) as Hex;
  }

  /** On-chain EIP-712 Assignment digest (M9); cross-check vs the off-chain orchestrator signer. */
  async assignmentDigest(e: RedundantEscrow): Promise<Hex> {
    return (await this.read("assignmentDigest", [e])) as Hex;
  }

  // --- writes (require a walletClient) ---

  escrow(jobId: Hex, amount: bigint, deadline: bigint): Promise<Hex> {
    return this.write("escrow", [jobId, amount, deadline]);
  }

  /** M9: buyer escrows a redundant job authorized by the orchestrator's `Assignment` signature. */
  escrowRedundant(e: RedundantEscrow, orchestratorSig: Hex): Promise<Hex> {
    return this.write("escrowRedundant", [e, orchestratorSig]);
  }

  settle(proof: ProofBundle, operator: Address): Promise<Hex> {
    return this.write("settle", [proof, operator]);
  }

  /** M9: an authorized committee member submits its proof with a Merkle membership proof. */
  submitProof(proof: ProofBundle, operator: Address, merkleProof: Hex[]): Promise<Hex> {
    return this.write("submitProof", [proof, operator, merkleProof]);
  }

  /** M9: void a PendingConsensus result within the challenge window (buyer-only on-chain). */
  challenge(jobId: Hex): Promise<Hex> {
    return this.write("challenge", [jobId]);
  }

  claim(jobId: Hex, operator: Address): Promise<Hex> {
    return this.write("claim", [jobId, operator]);
  }

  /** M9: a redundant-flow winner sweeps its pull-based reward. */
  withdrawReward(): Promise<Hex> {
    return this.write("withdrawReward", []);
  }

  /** Sweep accrued protocol fees + slashed bonds to the treasury (pull-based). */
  withdrawFees(): Promise<Hex> {
    return this.write("withdrawFees", []);
  }

  refund(jobId: Hex): Promise<Hex> {
    return this.write("refund", [jobId]);
  }

  // --- admin / M9 wiring (owner-only on-chain) ---

  setOrchestrator(newOrchestrator: Address): Promise<Hex> {
    return this.write("setOrchestrator", [newOrchestrator]);
  }

  setStaking(staking: Address): Promise<Hex> {
    return this.write("setStaking", [staking]);
  }

  // --- internals ---

  private read(functionName: string, args: readonly unknown[]): Promise<unknown> {
    return this.pub.readContract({ address: this.address, abi: settlementAbi, functionName, args });
  }

  private async write(functionName: string, args: readonly unknown[]): Promise<Hex> {
    if (!this.wallet?.account) {
      throw new Error(`SettlementClient.${functionName}: a walletClient with an account is required for writes`);
    }
    const { request } = await this.pub.simulateContract({
      address: this.address,
      abi: settlementAbi,
      functionName,
      args,
      account: this.wallet.account,
    });
    return this.wallet.writeContract(request);
  }
}

/** Decode Settlement event logs (for the indexer). */
export function decodeSettlementLogs(logs: Log[]) {
  return parseEventLogs({ abi: settlementAbi, logs });
}
