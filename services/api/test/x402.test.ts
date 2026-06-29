import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "@dawn/shared";
import type { DawnPublicClient } from "@dawn/shared/web3";
import { OnchainPaymentVerifier, parsePaymentHeader, type PaymentRequirements } from "../src/x402.ts";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const TREASURY = "0x1111111111111111111111111111111111111111" as Address;
const BUYER = "0x2222222222222222222222222222222222222222" as Address;
const TX = ("0x" + "ab".repeat(32)) as Hex;

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function pad32(addr: string): Hex {
  return ("0x" + "0".repeat(24) + addr.slice(2).toLowerCase()) as Hex;
}
function hex32(n: bigint): Hex {
  return ("0x" + n.toString(16).padStart(64, "0")) as Hex;
}

// A fake receipt-returning client carrying one ERC-20 Transfer log.
function clientWithTransfer(opts: {
  status?: "success" | "reverted";
  asset?: Address;
  to?: Address;
  value?: bigint;
}): DawnPublicClient {
  const log = {
    address: opts.asset ?? USDC,
    topics: [TRANSFER_TOPIC, pad32(BUYER), pad32(opts.to ?? TREASURY)],
    data: hex32(opts.value ?? 1_000_000n),
    blockNumber: 1n,
    blockHash: ("0x" + "00".repeat(32)) as Hex,
    logIndex: 0,
    transactionHash: TX,
    transactionIndex: 0,
    removed: false,
  };
  return {
    async getTransactionReceipt() {
      return { status: opts.status ?? "success", logs: [log] };
    },
  } as unknown as DawnPublicClient;
}

const req: PaymentRequirements = {
  scheme: "exact",
  network: "base-sepolia",
  asset: USDC,
  payTo: TREASURY,
  maxAmountRequired: "1000000", // 1 USDC (6 dp)
  resource: "POST /v1/jobs/x402",
};

describe("parsePaymentHeader", () => {
  test("accepts a bare 0x tx hash", () => {
    expect(parsePaymentHeader(TX)).toBe(TX);
  });
  test("accepts a JSON {txHash} envelope", () => {
    expect(parsePaymentHeader(JSON.stringify({ txHash: TX }))).toBe(TX);
  });
  test("rejects garbage", () => {
    expect(parsePaymentHeader("valid-test-payment")).toBeNull();
    expect(parsePaymentHeader("0x1234")).toBeNull();
  });
});

describe("OnchainPaymentVerifier", () => {
  test("accepts a sufficient USDC transfer to the treasury", async () => {
    const v = new OnchainPaymentVerifier(clientWithTransfer({ value: 1_000_000n }));
    const r = await v.verify(TX, req);
    expect(r.ok).toBe(true);
    expect(r.txRef).toBe(TX);
  });

  test("accepts an overpayment (>= required)", async () => {
    const v = new OnchainPaymentVerifier(clientWithTransfer({ value: 5_000_000n }));
    expect((await v.verify(TX, req)).ok).toBe(true);
  });

  test("rejects an underpayment", async () => {
    const v = new OnchainPaymentVerifier(clientWithTransfer({ value: 999_999n }));
    const r = await v.verify(TX, req);
    expect(r.ok).toBe(false);
  });

  test("rejects payment to the wrong recipient", async () => {
    const v = new OnchainPaymentVerifier(clientWithTransfer({ to: BUYER }));
    expect((await v.verify(TX, req)).ok).toBe(false);
  });

  test("rejects the wrong asset", async () => {
    const wrong = "0x9999999999999999999999999999999999999999" as Address;
    const v = new OnchainPaymentVerifier(clientWithTransfer({ asset: wrong }));
    expect((await v.verify(TX, req)).ok).toBe(false);
  });

  test("rejects a reverted transaction", async () => {
    const v = new OnchainPaymentVerifier(clientWithTransfer({ status: "reverted" }));
    expect((await v.verify(TX, req)).ok).toBe(false);
  });

  test("rejects a non-hash header", async () => {
    const v = new OnchainPaymentVerifier(clientWithTransfer({}));
    const r = await v.verify("not-a-hash", req);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/tx hash/);
  });
});
