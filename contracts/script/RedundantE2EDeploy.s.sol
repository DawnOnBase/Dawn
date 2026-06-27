// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Settlement} from "../src/Settlement.sol";
import {OperatorStaking} from "../src/OperatorStaking.sol";
import {IOperatorStaking} from "../src/interfaces/IOperatorStaking.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @notice M9 redundant-flow e2e — phase 1: deploy + wire Settlement + the isolated OperatorStaking
///         vault, set the orchestrator to ORCH_ADDR, mint, and have the 3 committee operators stake.
///         Prints the deployed addresses for the Go signer + the later phases. See scripts/e2e_redundant.sh.
contract RedundantE2EDeploy is Script {
    uint256 constant BUYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant OP0_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant OP1_KEY = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant OP2_KEY = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    address constant TREASURY = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65;

    uint16 constant FEE_BPS = 50;
    uint256 constant AMOUNT = 100e6;
    uint256 constant MIN_STAKE = 10e6;
    uint256 constant STAKE = 100e6;

    function run() external {
        address orch = vm.envAddress("ORCH_ADDR");

        vm.startBroadcast(BUYER_KEY);
        MockUSDC usdc = new MockUSDC();
        OperatorStaking staking = new OperatorStaking(IERC20(address(usdc)), MIN_STAKE, 7 days);
        Settlement s = new Settlement(IERC20(address(usdc)), TREASURY, FEE_BPS, true);
        staking.setSlasher(address(s));
        s.setStaking(IOperatorStaking(address(staking)));
        s.setOrchestrator(orch);
        usdc.mint(vm.addr(BUYER_KEY), AMOUNT);
        usdc.mint(vm.addr(OP0_KEY), STAKE);
        usdc.mint(vm.addr(OP1_KEY), STAKE);
        usdc.mint(vm.addr(OP2_KEY), STAKE);
        vm.stopBroadcast();

        _stake(staking, usdc, OP0_KEY);
        _stake(staking, usdc, OP1_KEY);
        _stake(staking, usdc, OP2_KEY);

        console2.log(string.concat("USDC=", vm.toString(address(usdc))));
        console2.log(string.concat("STAKING=", vm.toString(address(staking))));
        console2.log(string.concat("SETTLEMENT=", vm.toString(address(s))));
    }

    function _stake(OperatorStaking staking, MockUSDC usdc, uint256 key) internal {
        vm.startBroadcast(key);
        usdc.approve(address(staking), STAKE);
        staking.stake(STAKE);
        vm.stopBroadcast();
    }
}
