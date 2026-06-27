// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Settlement} from "../src/Settlement.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @notice One-shot local-chain (anvil) setup for the end-to-end test: deploy a mock
///         USDC + the Settlement, mint the buyer test USDC, and escrow JOB_ID — so the
///         agent can fetch a real Job Package, run it, prove it, and self-settle.
/// @dev    Env: JOB_ID (0x bytes32), TREASURY_ADDRESS. Broadcast key (--private-key)
///         is the buyer. Logs USDC + SETTLEMENT addresses for the harness to capture.
contract LocalE2E is Script {
    function run() external {
        bytes32 jobId = vm.envBytes32("JOB_ID");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        uint256 amount = vm.envOr("ESCROW_AMOUNT", uint256(1_000_000)); // 1 USDC
        uint64 deadline = uint64(block.timestamp + 1 days);

        vm.startBroadcast();
        MockUSDC usdc = new MockUSDC();
        usdc.mint(msg.sender, amount * 10);
        Settlement settlement = new Settlement(IERC20(address(usdc)), treasury, 50, false);
        usdc.approve(address(settlement), amount);
        settlement.escrow(jobId, amount, deadline);
        vm.stopBroadcast();

        console2.log("USDC=%s", address(usdc));
        console2.log("SETTLEMENT=%s", address(settlement));
        console2.log("AMOUNT=%s", amount);
    }
}
