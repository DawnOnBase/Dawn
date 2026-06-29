import { describe, expect, test } from "bun:test";
import type { Address, Hex, ProofBundle } from "@dawn/shared";
import { addressForPrivateKey, signProof } from "@dawn/shared/web3";
import {
  Eip712SignatureVerifier,
  OnchainSettlementSink,
  RedundantSettlementSink,
  type RedundantSettleWriter,
  type SettleWriter,
} from "../src/onchain.ts";
import type { SettlementInstruction } from "../src/service.ts";

const CHAIN_ID = 84532;
const SETTLEMENT = "0xc27C681cE93a63C0987226CDaC7b66232018651E" as Address;
const KEY = ("0x" + "11".repeat(32)) as Hex;

function b32(byte: string): Hex {
  return ("0x" + byte.repeat(32)) as Hex;
}

async function signedBundle(key: Hex, outputHash: Hex): Promise<ProofBundle> {
  const msg = { jobId: b32("aa"), inputHash: b32("bb"), outputHash, metadata: "0x" as Hex };
  const nodeSignature = await signProof(key, msg, CHAIN_ID, SETTLEMENT);
  return { ...msg, nodeSignature };
}

describe("Eip712SignatureVerifier", () => {
  test("recovers the exact signer address", async () => {
    const verifier = new Eip712SignatureVerifier(CHAIN_ID, SETTLEMENT);
    const bundle = await signedBundle(KEY, b32("cc"));
    const recovered = await verifier.recover(bundle);
    expect(recovered.toLowerCase()).toBe(addressForPrivateKey(KEY).toLowerCase());
  });

  test("a different signer recovers to a different address", async () => {
    const verifier = new Eip712SignatureVerifier(CHAIN_ID, SETTLEMENT);
    const other = ("0x" + "22".repeat(32)) as Hex;
    const recovered = await verifier.recover(await signedBundle(other, b32("cc")));
    expect(recovered.toLowerCase()).toBe(addressForPrivateKey(other).toLowerCase());
    expect(recovered.toLowerCase()).not.toBe(addressForPrivateKey(KEY).toLowerCase());
  });

  test("tampering with outputHash changes the recovered signer", async () => {
    const verifier = new Eip712SignatureVerifier(CHAIN_ID, SETTLEMENT);
    const bundle = await signedBundle(KEY, b32("cc"));
    const tampered: ProofBundle = { ...bundle, outputHash: b32("dd") };
    const recovered = await verifier.recover(tampered);
    // Signature no longer matches the message → recovers to some other address.
    expect(recovered.toLowerCase()).not.toBe(addressForPrivateKey(KEY).toLowerCase());
  });
});

describe("OnchainSettlementSink", () => {
  function instr(overrides: Partial<SettlementInstruction> = {}): SettlementInstruction {
    return {
      jobId: b32("aa"),
      outputHash: b32("cc"),
      operator: addressForPrivateKey(KEY),
      proof: {
        jobId: b32("aa"),
        inputHash: b32("bb"),
        outputHash: b32("cc"),
        metadata: "0x",
        nodeSignature: ("0x" + "00".repeat(65)) as Hex,
      },
      pay: [addressForPrivateKey(KEY)],
      penalize: [],
      winners: [],
      ...overrides,
    };
  }

  test("submits the winning proof + operator to the contract", async () => {
    const calls: Array<{ proof: ProofBundle; operator: Address }> = [];
    const writer: SettleWriter = {
      async settle(proof, operator) {
        calls.push({ proof, operator });
        return ("0x" + "ab".repeat(32)) as Hex;
      },
    };
    const sink = new OnchainSettlementSink(writer);
    await sink.settle(instr());
    expect(calls.length).toBe(1);
    expect(calls[0]!.operator.toLowerCase()).toBe(addressForPrivateKey(KEY).toLowerCase());
    expect(calls[0]!.proof.outputHash).toBe(b32("cc"));
  });

  test("refuses to settle when there are dissenters to penalize (redundant flow disabled)", async () => {
    const writer: SettleWriter = {
      async settle() {
        return ("0x" + "ab".repeat(32)) as Hex;
      },
    };
    const sink = new OnchainSettlementSink(writer);
    await expect(sink.settle(instr({ penalize: ["0x" + "99".repeat(20)] as Address[] }))).rejects.toThrow(
      /redundant slashing is disabled/,
    );
  });

  test("refuses a redundant instruction (>1 winner) misrouted to the single-node sink", async () => {
    const writer: SettleWriter = {
      async settle() {
        return ("0x" + "ab".repeat(32)) as Hex;
      },
    };
    const sink = new OnchainSettlementSink(writer);
    await expect(sink.settle(instr({ winners: committee(2) }))).rejects.toThrow(/misrouted to the single-node sink/);
  });
});

function committee(n: number): SettlementInstruction["winners"] {
  const keys = ["11", "22", "33", "44", "55"];
  return Array.from({ length: n }, (_, i) => {
    const key = ("0x" + keys[i]!.repeat(32)) as Hex;
    return {
      operator: addressForPrivateKey(key),
      proof: {
        jobId: ("0x" + "aa".repeat(32)) as Hex,
        inputHash: ("0x" + "bb".repeat(32)) as Hex,
        outputHash: ("0x" + "cc".repeat(32)) as Hex,
        metadata: "0x" as Hex,
        nodeSignature: ("0x" + "00".repeat(65)) as Hex,
      },
      merkleProof: [("0x" + String(i).repeat(64)) as Hex],
    };
  });
}

describe("RedundantSettlementSink (S3)", () => {
  function instr(winners: SettlementInstruction["winners"]): SettlementInstruction {
    return {
      jobId: ("0x" + "aa".repeat(32)) as Hex,
      outputHash: ("0x" + "cc".repeat(32)) as Hex,
      operator: winners[0]?.operator ?? ("0x" + "00".repeat(20)) as Address,
      proof: winners[0]?.proof ?? {
        jobId: ("0x" + "aa".repeat(32)) as Hex,
        inputHash: ("0x" + "bb".repeat(32)) as Hex,
        outputHash: ("0x" + "cc".repeat(32)) as Hex,
        metadata: "0x" as Hex,
        nodeSignature: ("0x" + "00".repeat(65)) as Hex,
      },
      pay: winners.map((w) => w.operator),
      penalize: [],
      winners,
    };
  }

  test("submits submitProof(proof, operator, merkleProof) for every winner", async () => {
    const calls: Array<{ operator: Address; merkleProof: Hex[] }> = [];
    const writer: RedundantSettleWriter = {
      async submitProof(_proof, operator, merkleProof) {
        calls.push({ operator, merkleProof });
        return ("0x" + "ab".repeat(32)) as Hex;
      },
    };
    const sink = new RedundantSettlementSink(writer);
    const winners = committee(2);
    await sink.settle(instr(winners));
    expect(calls.length).toBe(2);
    expect(calls[0]!.operator).toBe(winners[0]!.operator);
    expect(calls[1]!.operator).toBe(winners[1]!.operator);
    expect(calls[0]!.merkleProof).toEqual(winners[0]!.merkleProof);
  });

  test("refuses a single-node instruction (<=1 winner) misrouted to the redundant sink", async () => {
    const writer: RedundantSettleWriter = {
      async submitProof() {
        return ("0x" + "ab".repeat(32)) as Hex;
      },
    };
    const sink = new RedundantSettlementSink(writer);
    await expect(sink.settle(instr(committee(1)))).rejects.toThrow(/expected a committee/);
  });
});
