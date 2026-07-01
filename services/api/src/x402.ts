// x402 agent-payment flow. The HTTP 402 handshake is handled
// here; verifying/settling the payment ON-CHAIN is shared with the agent
// That on-chain step sits behind PaymentVerifier so this service
// builds and tests without a chain, and the real verifier drops in later.

import type { Address, Hex } from "@dawn/shared";
import { verifyUsdcTransfer, type DawnPublicClient } from "@dawn/shared/web3";

export interface PaymentRequirements {
  scheme: "exact";
  network: "base" | "base-sepolia";
  asset: Address; // USDC contract address
  payTo: Address; // treasury
  maxAmountRequired: string; // USDC base units (6 dp)
  resource: string; // identifies what is being paid for
}

export interface PaymentResult {
  ok: boolean;
  txRef?: Hex; // settlement tx hash, once on-chain
  reason?: string;
}

export interface PaymentVerifier {
  verify(paymentHeader: string, req: PaymentRequirements): Promise<PaymentResult>;
}

// StubPaymentVerifier is for local dev/tests only: it accepts a fixed sentinel
// header and never touches a chain.
export class StubPaymentVerifier implements PaymentVerifier {
  constructor(private readonly accept = "valid-test-payment") {}
  async verify(paymentHeader: string, _req: PaymentRequirements): Promise<PaymentResult> {
    if (paymentHeader === this.accept) {
      return { ok: true, txRef: ("0x" + "11".repeat(32)) as Hex };
    }
    return { ok: false, reason: "payment not verified" };
  }
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** Extract the settlement tx hash from the X-PAYMENT header. Accepts a bare
 *  0x hash or a JSON object `{ "txHash": "0x.." }` (x402 payload envelope). */
export function parsePaymentHeader(header: string): Hex | null {
  const raw = header.trim();
  if (TX_HASH.test(raw)) return raw as Hex;
  try {
    const obj = JSON.parse(raw) as { txHash?: string; txRef?: string };
    const h = obj.txHash ?? obj.txRef;
    if (typeof h === "string" && TX_HASH.test(h)) return h as Hex;
  } catch {
    // not JSON — fall through
  }
  return null;
}

// OnchainPaymentVerifier confirms an x402 "exact" payment on-chain: the buyer
// transfers USDC to the treasury, then presents the settlement tx hash. We check
// the tx succeeded and moved >= the required amount of the expected asset to the
// expected recipient. 
export class OnchainPaymentVerifier implements PaymentVerifier {
  constructor(private readonly client: DawnPublicClient) {}

  async verify(paymentHeader: string, req: PaymentRequirements): Promise<PaymentResult> {
    const txHash = parsePaymentHeader(paymentHeader);
    if (!txHash) return { ok: false, reason: "x-payment must be a 0x tx hash or {txHash}" };

    let minAmount: bigint;
    try {
      minAmount = BigInt(req.maxAmountRequired);
    } catch {
      return { ok: false, reason: "invalid required amount" };
    }

    const res = await verifyUsdcTransfer(this.client, {
      asset: req.asset,
      payTo: req.payTo,
      minAmount,
      txHash,
    });
    return res.ok ? { ok: true, txRef: txHash } : { ok: false, reason: res.reason };
  }
}
