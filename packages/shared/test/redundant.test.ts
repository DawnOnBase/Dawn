import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  ASSIGNMENT_TYPES,
  assignmentMessageFromEscrow,
  type AssignmentAuthorization,
  escrowRedundantJob,
  recoverAssignmentSigner,
  redundantEscrowFromAuthorization,
  settlementDomain,
} from "../src/web3";
import type { Address, Hex } from "../src/types";

const CHAIN_ID = 31337;
const SETTLEMENT = "0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3" as Address;
const ORCH_KEY = ("0x" + "11".repeat(32)) as Hex;
const orch = privateKeyToAccount(ORCH_KEY);

function authBase(): AssignmentAuthorization {
  return {
    jobId: ("0x" + "ab".repeat(32)) as Hex,
    operators: [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      "0x3333333333333333333333333333333333333333",
    ] as Address[],
    operatorSetRoot: ("0x" + "cd".repeat(32)) as Hex,
    assignmentSig: "0x" as Hex,
    inputHash: ("0x" + "ef".repeat(32)) as Hex,
    nonce: 1,
    bond: "10000000",
    amount: "100000000",
    deadline: 9_999_999_999,
    redundancy: 3,
  };
}

// Produce a genuine orchestrator-signed authorization (as POST /v1/assignments would return).
async function signedAuth(): Promise<AssignmentAuthorization> {
  const a = authBase();
  const msg = assignmentMessageFromEscrow(redundantEscrowFromAuthorization(a));
  const sig = await orch.signTypedData({
    domain: settlementDomain(CHAIN_ID, SETTLEMENT),
    types: ASSIGNMENT_TYPES,
    primaryType: "Assignment",
    message: msg,
  });
  return { ...a, assignmentSig: sig };
}

describe("S1 — escrowRedundant caller", () => {
  test("builds the on-chain RedundantEscrow tuple from the authorization", () => {
    const e = redundantEscrowFromAuthorization(authBase());
    expect(e.amount).toBe(100_000_000n);
    expect(e.bond).toBe(10_000_000n);
    expect(e.deadline).toBe(9_999_999_999n);
    expect(e.redundancy).toBe(3);
    expect(e.nonce).toBe(1n);
    expect(e.operatorSetRoot).toBe(authBase().operatorSetRoot);
  });

  test("the buyer's escrow tuple + orchestrator sig recover the orchestrator (contract would accept)", async () => {
    const a = await signedAuth();
    const e = redundantEscrowFromAuthorization(a);
    const recovered = await recoverAssignmentSigner(a.assignmentSig, assignmentMessageFromEscrow(e), CHAIN_ID, SETTLEMENT);
    expect(recovered.toLowerCase()).toBe(orch.address.toLowerCase());
  });

  test("escrowRedundantJob verifies the signer, approves USDC, then escrows", async () => {
    const a = await signedAuth();
    const buyer = { address: "0x4444444444444444444444444444444444444444" as Address };
    let escrowed: { e: { amount: bigint }; sig: Hex } | null = null;
    let approves = 0;

    const publicClient = {
      getChainId: async () => CHAIN_ID,
      // allowance starts at 0 → triggers an approve
      readContract: async () => 0n,
      simulateContract: async ({ functionName, args }: { functionName: string; args: unknown }) => ({
        request: { functionName, args },
      }),
    };
    const walletClient = {
      account: buyer,
      writeContract: async () => {
        approves++;
        return "0xapprovetx" as Hex;
      },
    };
    const client = {
      address: SETTLEMENT,
      orchestrator: async () => orch.address,
      escrowRedundant: async (e: { amount: bigint }, sig: Hex) => {
        escrowed = { e, sig };
        return "0xescrowtx" as Hex;
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await escrowRedundantJob({ client, usdc: "0xUSDC" as Address, publicClient, walletClient, authorization: a } as any);
    expect(res.approveTx).toBe("0xapprovetx");
    expect(res.escrowTx).toBe("0xescrowtx");
    expect(approves).toBe(1);
    expect(escrowed!.sig).toBe(a.assignmentSig);
    expect(escrowed!.e.amount).toBe(100_000_000n);
  });

  test("escrowRedundantJob refuses when the sig doesn't match the on-chain orchestrator", async () => {
    const a = await signedAuth();
    const client = {
      address: SETTLEMENT,
      orchestrator: async () => "0x9999999999999999999999999999999999999999" as Address, // wrong orchestrator
    };
    const publicClient = { getChainId: async () => CHAIN_ID };
    const walletClient = { account: { address: "0x4444444444444444444444444444444444444444" as Address } };
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      escrowRedundantJob({ client, usdc: "0xU" as Address, publicClient, walletClient, authorization: a } as any),
    ).rejects.toThrow(/orchestrator/);
  });
});
