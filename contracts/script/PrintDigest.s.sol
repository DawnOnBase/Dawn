// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Settlement} from "../src/Settlement.sol";
import {ISettlement} from "../src/interfaces/ISettlement.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @notice Prints the on-chain EIP-712 reference values for a fixed proof so the TS client
///         (packages/shared/web3) can prove its proofDigest() matches the contract byte-for-byte.
/// @dev Run: forge script script/PrintDigest.s.sol
contract PrintDigest is Script {
    function run() external {
        Settlement s = new Settlement(IERC20(address(0xdEaD)), address(0xBEEF), 50, false);
        ISettlement.ProofBundle memory p = ISettlement.ProofBundle({
            jobId: keccak256("job"),
            inputHash: keccak256("in"),
            outputHash: keccak256("out"),
            metadata: bytes("meta"),
            nodeSignature: ""
        });
        console2.log("CHAINID", block.chainid);
        console2.log("SETTLEMENT", address(s));
        console2.log("DOMSEP", vm.toString(s.domainSeparator()));
        console2.log("DIGEST", vm.toString(s.proofDigest(p)));
    }
}
