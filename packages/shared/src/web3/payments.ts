// On-chain payment verification for the x402 "exact" scheme .
//
// A buyer pays USDC to the treasury, then presents the settlement tx hash in the
// `X-PAYMENT` header. We confirm on-chain that the referenced transaction
// succeeded and contains an ERC-20 Transfer of >= the required amount of the
// expected asset (USDC) to the expected recipient (treasury). This is asset- and
// recipient-bound, so a payment to the wrong token or address does not pass.

import { getAddress, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";

const ERC20_TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

export interface UsdcPaymentCheck {
  asset: Address; // expected token (USDC) contract
  payTo: Address; // expected recipient (treasury)
  minAmount: bigint; // minimum USDC base units (6 dp) that must be transferred
  txHash: Hex; // the settlement transaction to inspect
}

export interface PaymentCheckResult {
  ok: boolean;
  reason?: string;
  /** The matching transferred amount, when ok. */
  amount?: bigint;
}

function eqAddr(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/**
 * Verify a USDC transfer to `payTo` of at least `minAmount` occurred in the
 * given transaction. Reverted transactions and transfers of the wrong asset /
 * recipient / amount fail.
 */
export async function verifyUsdcTransfer(
  client: PublicClient,
  check: UsdcPaymentCheck,
): Promise<PaymentCheckResult> {
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: check.txHash });
  } catch {
    return { ok: false, reason: "transaction not found or not yet mined" };
  }
  if (receipt.status !== "success") {
    return { ok: false, reason: "payment transaction reverted" };
  }

  const transfers = parseEventLogs({ abi: ERC20_TRANSFER_ABI, logs: receipt.logs, eventName: "Transfer" });
  for (const t of transfers) {
    const args = t.args as { to: Address; value: bigint };
    if (eqAddr(t.address, check.asset) && eqAddr(args.to, check.payTo) && args.value >= check.minAmount) {
      return { ok: true, amount: args.value };
    }
  }
  return { ok: false, reason: "no matching USDC transfer to treasury found" };
}
