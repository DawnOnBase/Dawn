// M9 seam S1 — the buyer-side escrowRedundant caller. Consumes the orchestrator authorization
// returned by `POST /v1/assignments` (services/job-queue/internal/dispatch), builds the on-chain
// RedundantEscrow tuple, ensures USDC allowance, and submits escrowRedundant with the buyer as
// msg.sender (M0 D4 — the buyer pays escrow; operators stake/lock their own bond at submitProof,
// so the buyer does NOT approve a bond).

import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { SettlementClient, type RedundantEscrow } from "./client";
import { recoverAssignmentSigner, type AssignmentMessage } from "./eip712";

/** The `POST /v1/assignments` response: an orchestrator-signed committee authorization. */
export interface AssignmentAuthorization {
  jobId: Hex;
  operators: Address[];
  operatorSetRoot: Hex;
  assignmentSig: Hex;
  inputHash: Hex;
  nonce: number;
  bond: string; // USDC base units
  amount: string; // USDC base units
  deadline: number; // unix seconds
  redundancy: number;
}

/** Build the on-chain `RedundantEscrow` tuple from an orchestrator authorization. */
export function redundantEscrowFromAuthorization(a: AssignmentAuthorization): RedundantEscrow {
  return {
    jobId: a.jobId,
    amount: BigInt(a.amount),
    deadline: BigInt(a.deadline),
    redundancy: a.redundancy,
    bond: BigInt(a.bond),
    inputHash: a.inputHash,
    operatorSetRoot: a.operatorSetRoot,
    nonce: BigInt(a.nonce),
  };
}

/** The Assignment EIP-712 message for an escrow (same 8 fields) — for the signer sanity check. */
export function assignmentMessageFromEscrow(e: RedundantEscrow): AssignmentMessage {
  return {
    jobId: e.jobId,
    inputHash: e.inputHash,
    operatorSetRoot: e.operatorSetRoot,
    redundancy: e.redundancy,
    deadline: e.deadline,
    amount: e.amount,
    bond: e.bond,
    nonce: e.nonce,
  };
}

const ERC20_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface EscrowRedundantOptions {
  client: SettlementClient;
  usdc: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
  authorization: AssignmentAuthorization;
  /** Skip the pre-flight orchestrator-signature check (default false — verify before paying gas). */
  skipVerify?: boolean;
}

/**
 * Buyer-side escrowRedundant flow: optionally pre-flight that the authorization signature recovers
 * the on-chain orchestrator over THIS escrow (else escrowRedundant reverts BAD_ASSIGNMENT after
 * we've paid gas), ensure USDC allowance covers `amount`, then submit escrowRedundant.
 * The buyer is msg.sender; returns the (optional) approval tx + the escrow tx.
 */
export async function escrowRedundantJob(opts: EscrowRedundantOptions): Promise<{ approveTx?: Hex; escrowTx: Hex }> {
  const { client, usdc, publicClient, walletClient, authorization } = opts;
  const account = walletClient.account;
  if (!account) throw new Error("escrowRedundantJob: walletClient needs an account");

  const e = redundantEscrowFromAuthorization(authorization);

  if (!opts.skipVerify) {
    const chainId = await publicClient.getChainId();
    const signer = await recoverAssignmentSigner(
      authorization.assignmentSig,
      assignmentMessageFromEscrow(e),
      chainId,
      client.address,
    );
    const orchestrator = await client.orchestrator();
    if (signer.toLowerCase() !== orchestrator.toLowerCase()) {
      throw new Error(`escrowRedundantJob: assignment signer ${signer} != on-chain orchestrator ${orchestrator}`);
    }
  }

  let approveTx: Hex | undefined;
  const allowance = (await publicClient.readContract({
    address: usdc,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: "allowance",
    args: [account.address, client.address],
  })) as bigint;
  if (allowance < e.amount) {
    const { request } = await publicClient.simulateContract({
      address: usdc,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: "approve",
      args: [client.address, e.amount],
      account,
    });
    approveTx = await walletClient.writeContract(request);
  }

  const escrowTx = await client.escrowRedundant(e, authorization.assignmentSig);
  return { approveTx, escrowTx };
}
