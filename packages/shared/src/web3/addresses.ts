import type { Address } from "viem";

export const CHAIN_IDS = {
  baseMainnet: 8453,
  baseSepolia: 84532,
} as const;

export type DawnChainId = (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS];

/**
 * Deployed Settlement addresses per chain .
 * Keep in sync with the deploy broadcast.
 *
 * baseSepolia: deployed 2026-06-28, single-node only (redundantEnabled=false),
 *   usdc=0x036CbD53842c5426634e7929541eC2318f3dCF7e, feeBps=50.
 *   tx 0xfeb4d84608373f8971c975c1a162352cdee067db2cb17b1d39f2cc3868b00973 (block 43467176).
 *   EIP-712 domainSeparator cross-checked vs the TS + Rust clients.
 * baseMainnet: deployed 2026-06-30, single-node only (redundantEnabled=false),
 *   usdc=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, feeBps=50, owner=treasury=deployer EOA
 *   0x0000000000000000000000000000000000000000. tx 0x6a88ab4eae226d9c885d5742f692baa98061a1640f07c3af7fbef9fd47f87631
 *   (block 48037231). On-chain config verified post-deploy. Same address as baseSepolia
 *   (same deployer + nonce ⇒ identical CREATE address; benign, keyed separately by chain).
 */
export const SETTLEMENT_ADDRESS: Partial<Record<DawnChainId, Address>> = {
  [CHAIN_IDS.baseSepolia]: "0xc27C681cE93a63C0987226CDaC7b66232018651E",
  [CHAIN_IDS.baseMainnet]: "0xc27C681cE93a63C0987226CDaC7b66232018651E",
};

/**
 * Block the Settlement contract was deployed at, per chain. The indexer starts
 * its log scan here (not genesis) when it has no saved cursor.
 */
export const SETTLEMENT_DEPLOY_BLOCK: Partial<Record<DawnChainId, bigint>> = {
  [CHAIN_IDS.baseSepolia]: 43467176n, // tx 0xfeb4d846…b00973
  [CHAIN_IDS.baseMainnet]: 48037231n, // tx 0x6a88ab4e…87631
};

/**
 * Deployed OperatorStaking address per chain (M9 capital-isolation vault). EMPTY until the
 * audited redundant-flow Settlement is redeployed (redundantEnabled), so the stake indexer / oracle
 * stay dormant until an address is configured (via env or a recorded deployment here).
 */
export const OPERATOR_STAKING_ADDRESS: Partial<Record<DawnChainId, Address>> = {
  // [CHAIN_IDS.baseSepolia]: "0x...",  // after the redundant-flow redeploy
};

/** Block OperatorStaking was deployed at, per chain (stake indexer cold-start). */
export const OPERATOR_STAKING_DEPLOY_BLOCK: Partial<Record<DawnChainId, bigint>> = {};

/**
 * USDC (the settlement asset) per chain — verify against Circle's official docs
 * before mainnet. Base Sepolia is Circle's testnet USDC; the
 * deployed Settlement at baseSepolia was wired to exactly this address.
 */
export const USDC_ADDRESS: Record<DawnChainId, Address> = {
  [CHAIN_IDS.baseSepolia]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  [CHAIN_IDS.baseMainnet]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
