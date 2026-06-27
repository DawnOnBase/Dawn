// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Settlement} from "../src/Settlement.sol";
import {ISettlement} from "../src/interfaces/ISettlement.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @notice Live money-path smoke test against a DEPLOYED Settlement: a buyer escrows
///         USDC for a job, a node signs an EIP-712 proof, and `settle` pays the
///         operator `amount - fee`. Proves the single-node flow end-to-end on-chain.
///
/// @dev    Requires the buyer wallet to already hold USDC for the target chain
///         (Base Sepolia faucet: https://faucet.circle.com; on mainnet use real USDC).
///         The buyer broadcasts everything (approve/escrow/settle); the node key only
///         signs the proof and receives the payout, so it needs no gas or balance.
///
///         Env:
///           SETTLEMENT_ADDRESS   deployed Settlement
///           USDC_ADDRESS         USDC token
///           DEPLOYER_PRIVATE_KEY buyer / broadcaster (holds the USDC + gas)
///           NODE_PRIVATE_KEY     operator that signs + gets paid. REQUIRED on any live
///                                chain — on testnet it defaults to a public Anvil key.
///           SMOKE_AMOUNT         (optional) escrow amount in USDC base units; default 1e6 (1 USDC)
///
///         forge script script/SmokeSettle.s.sol --rpc-url base --broadcast
contract SmokeSettle is Script {
    // Anvil account #1 — a public test key; only ever holds test USDC here. Override with NODE_PRIVATE_KEY.
    uint256 internal constant DEFAULT_NODE_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    function run() external {
        Settlement settlement = Settlement(vm.envAddress("SETTLEMENT_ADDRESS"));
        IERC20 usdc = IERC20(vm.envAddress("USDC_ADDRESS"));
        uint256 buyerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 nodeKey = vm.envOr("NODE_PRIVATE_KEY", DEFAULT_NODE_KEY);
        // On any non-testnet chain, refuse to pay the operator payout to the public
        // Anvil key — a real operator key MUST be supplied or the USDC is effectively
        // burned to a known address. 84532 = Base Sepolia (the only allowed default).
        require(
            block.chainid == 84532 || nodeKey != DEFAULT_NODE_KEY,
            "set NODE_PRIVATE_KEY: refusing to pay the public Anvil test key on a live chain"
        );
        uint256 amount = vm.envOr("SMOKE_AMOUNT", uint256(1_000_000)); // 1 USDC (6 dp)

        address buyer = vm.addr(buyerKey);
        address operator = vm.addr(nodeKey);

        console2.log("buyer:        ", buyer);
        console2.log("operator:     ", operator);
        console2.log("escrow amount:", amount);
        require(
            usdc.balanceOf(buyer) >= amount,
            "buyer USDC balance < escrow amount (testnet: https://faucet.circle.com; mainnet: fund with real USDC)"
        );

        // Unique per run so re-runs don't hit JOB_EXISTS.
        bytes32 jobId = keccak256(abi.encode("dawn-smoke", buyer, block.timestamp));
        ISettlement.ProofBundle memory proof = _signedProof(settlement, nodeKey, jobId);

        uint256 expectedPayout = amount - (amount * settlement.feeBps()) / 10_000;
        uint256 fee = amount - expectedPayout;
        uint256 opBefore = usdc.balanceOf(operator);
        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.startBroadcast(buyerKey);
        usdc.approve(address(settlement), amount);
        settlement.escrow(jobId, amount, uint64(block.timestamp + 1 days));
        settlement.settle(proof, operator);
        vm.stopBroadcast();

        // When operator == buyer (a self-contained smoke with one wallet), the escrow-out
        // and payout-in net to just the protocol fee on that single account — asserting a
        // raw balance-increase would underflow. Assert on the correct net in each case.
        if (operator == buyer) {
            require(usdc.balanceOf(buyer) == buyerBefore - fee, "buyer net change != -fee");
            console2.log("buyer==operator: settled, net cost = fee only:", fee);
        } else {
            uint256 received = usdc.balanceOf(operator) - opBefore;
            require(received == expectedPayout, "payout != amount - fee");
            console2.log("operator received:", received);
        }
        console2.log("SMOKE OK: escrow -> signed proof -> settle paid the operator on-chain.");
    }

    /// Build the node's EIP-712 proof and sign it with the contract's own digest (so it
    /// is byte-identical to what `settle` verifies). Kept separate to bound stack depth.
    function _signedProof(Settlement settlement, uint256 nodeKey, bytes32 jobId)
        internal
        view
        returns (ISettlement.ProofBundle memory proof)
    {
        proof = ISettlement.ProofBundle({
            jobId: jobId,
            inputHash: keccak256("dawn-smoke-input"),
            outputHash: keccak256("dawn-smoke-output"),
            metadata: bytes("smoke"),
            nodeSignature: ""
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(nodeKey, settlement.proofDigest(proof));
        proof.nodeSignature = abi.encodePacked(r, s, v);
    }
}
