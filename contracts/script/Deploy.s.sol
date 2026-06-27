// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Settlement} from "../src/Settlement.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @notice Deploy the Settlement contract.
/// @dev Set env: USDC_ADDRESS, TREASURY_ADDRESS, optional FEE_BPS (default 50).
///      forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
contract Deploy is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(50)));

        // redundantEnabled = false: ship single-node only until the redundant-consensus design is
        // fixed for Sybil resistance (SECURITY.md). Enabling requires a redesign + redeploy.
        vm.startBroadcast();
        Settlement settlement = new Settlement(IERC20(usdc), treasury, feeBps, false);
        vm.stopBroadcast();

        console2.log("Settlement deployed:", address(settlement));
    }
}
