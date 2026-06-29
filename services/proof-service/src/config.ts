// Chain configuration for the proof-service .
//
// EIP-712 signature recovery is pure crypto and is ALWAYS on (it needs only the
// chainId + Settlement address that bind the domain). On-chain settlement is
// opt-in: it activates only when SETTLEMENT_PRIVATE_KEY is set, so dev/test runs
// validate consensus without touching a chain.

import type { Address, Hex } from "@dawn/shared";
import { CHAIN_IDS, settlementAddressFor, type DawnChainId } from "@dawn/shared/web3";

export interface ProofServiceConfig {
  chainId: DawnChainId;
  rpcUrl?: string;
  settlement: Address;
  /** When present, the service submits settlements on-chain; else it logs them. */
  settlementKey?: Hex;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ProofServiceConfig {
  const chainId = Number(env.CHAIN_ID ?? CHAIN_IDS.baseSepolia) as DawnChainId;
  // Fail LOUD on a malformed SETTLEMENT_ADDRESS (e.g. an un-filled deploy placeholder):
  // it becomes the EIP-712 verifyingContract, so a bad value would silently reject every
  // proof at runtime (HTTP 422) instead of failing at boot. An empty/whitespace value
  // (e.g. compose's `${SETTLEMENT_ADDRESS:-}`) counts as UNSET → resolve the recorded
  // address from @dawn/shared addresses.ts via chainId.
  const envSettlement = env.SETTLEMENT_ADDRESS?.trim() || undefined;
  if (envSettlement !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(envSettlement)) {
    throw new Error(`proof-service: SETTLEMENT_ADDRESS is not a valid address: "${envSettlement}"`);
  }
  const settlement = (envSettlement as Address | undefined) ?? settlementAddressFor(chainId);
  return {
    chainId,
    rpcUrl: env.RPC_URL,
    settlement,
    // Empty string (unset in compose) ⇒ undefined ⇒ verify/record-only (no settler).
    settlementKey: (env.SETTLEMENT_PRIVATE_KEY?.trim() || undefined) as Hex | undefined,
  };
}
