// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Settlement} from "../src/Settlement.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @notice M9 redundant-flow e2e — phase 3 (after the challenge window is warped past): finalize the
///         two winners and sweep their pull-based rewards, asserting each is paid (amount-fee)/quorum.
contract RedundantE2EClaim is Script {
    uint256 constant BUYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant OP0_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant OP1_KEY = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;

    function run() external {
        Settlement s = Settlement(vm.envAddress("SETTLEMENT"));
        MockUSDC usdc = MockUSDC(vm.envAddress("USDC"));
        bytes32 jobId = vm.envBytes32("JOBID");
        uint256 amount = vm.envUint("AMOUNT");
        address op0 = vm.addr(OP0_KEY);
        address op1 = vm.addr(OP1_KEY);

        // Permissionless finalization, then each winner sweeps its reward.
        vm.startBroadcast(BUYER_KEY);
        s.claim(jobId, op0);
        s.claim(jobId, op1);
        vm.stopBroadcast();
        vm.broadcast(OP0_KEY);
        s.withdrawReward();
        vm.broadcast(OP1_KEY);
        s.withdrawReward();

        uint256 fee = (amount * 50) / 10_000;
        uint256 reward = (amount - fee) / 2; // quorum = 2
        require(usdc.balanceOf(op0) == reward, "op0 reward mismatch");
        require(usdc.balanceOf(op1) == reward, "op1 reward mismatch");
        console2.log(string.concat("PAID_OK reward=", vm.toString(reward)));
    }
}
