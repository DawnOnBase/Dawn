// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Settlement} from "../src/Settlement.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @notice Escrow a job on the live Settlement so the agent can settle it. Pairs
///         with apps/agent's mock-backend demo: escrow JOB_ID here, then point the
///         mock backend's DAWN_MOCK_JOBID at the same id; the agent runs it, signs
///         a proof, and self-settles.
///
/// @dev    Env: SETTLEMENT_ADDRESS, USDC_ADDRESS, DEPLOYER_PRIVATE_KEY (the buyer,
///         holding test USDC), JOB_ID (0x bytes32), optional ESCROW_AMOUNT (default
///         1e6 = 1 USDC) and ESCROW_DEADLINE (default now + 1 day).
///
///         forge script script/EscrowJob.s.sol --rpc-url https://sepolia.base.org --broadcast
contract EscrowJob is Script {
    function run() external {
        Settlement settlement = Settlement(vm.envAddress("SETTLEMENT_ADDRESS"));
        IERC20 usdc = IERC20(vm.envAddress("USDC_ADDRESS"));
        uint256 buyerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        bytes32 jobId = vm.envBytes32("JOB_ID");
        uint256 amount = vm.envOr("ESCROW_AMOUNT", uint256(1_000_000)); // 1 USDC
        uint64 deadline = uint64(vm.envOr("ESCROW_DEADLINE", block.timestamp + 1 days));

        address buyer = vm.addr(buyerKey);
        require(
            usdc.balanceOf(buyer) >= amount,
            "buyer needs test USDC - get some at https://faucet.circle.com (Base Sepolia)"
        );

        vm.startBroadcast(buyerKey);
        usdc.approve(address(settlement), amount);
        settlement.escrow(jobId, amount, deadline);
        vm.stopBroadcast();

        console2.log("Escrowed job (set DAWN_MOCK_JOBID to this):");
        console2.logBytes32(jobId);
        console2.log("amount (base units):", amount);
        console2.log("deadline:", deadline);
    }
}
