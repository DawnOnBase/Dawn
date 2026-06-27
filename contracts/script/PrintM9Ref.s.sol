// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Settlement} from "../src/Settlement.sol";
import {ISettlement} from "../src/interfaces/ISettlement.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @notice Prints on-chain EIP-712 Assignment + Merkle reference values for fixed inputs, so the
///         Go orchestrator signer (services/job-queue/internal/orchestrator) can prove its digest
///         and committee root match the contract byte-for-byte (mirrors PrintDigest for proofs).
/// @dev Run: forge script script/PrintM9Ref.s.sol
contract PrintM9Ref is Script {
    function run() external {
        Settlement s = new Settlement(IERC20(address(0xdEaD)), address(0xBEEF), 50, false);
        ISettlement.RedundantEscrow memory e = ISettlement.RedundantEscrow({
            jobId: keccak256("job"),
            amount: 100000000, // 100 USDC
            deadline: 1000000,
            redundancy: 3,
            bond: 10000000, // 10 USDC
            inputHash: keccak256("in"),
            operatorSetRoot: keccak256("opset"),
            nonce: 1
        });
        console2.log("CHAINID", block.chainid);
        console2.log("SETTLEMENT", vm.toString(address(s)));
        console2.log("DOMSEP", vm.toString(s.domainSeparator()));
        console2.log("ASSIGNMENT_DIGEST", vm.toString(s.assignmentDigest(e)));

        // Sorted-pair Merkle (leaf = keccak256(abi.encodePacked(addr)), promote-odd) over a fixed
        // 3-operator committee — must equal the Go committee builder and Settlement._verifyMembership.
        address o0 = 0x1111111111111111111111111111111111111111;
        address o1 = 0x2222222222222222222222222222222222222222;
        address o2 = 0x3333333333333333333333333333333333333333;
        bytes32 l0 = keccak256(abi.encodePacked(o0));
        bytes32 l1 = keccak256(abi.encodePacked(o1));
        bytes32 l2 = keccak256(abi.encodePacked(o2));
        bytes32 root3 = _pair(_pair(l0, l1), l2);
        console2.log("MERKLE_ROOT_3", vm.toString(root3));

        // 2-operator committee root.
        console2.log("MERKLE_ROOT_2", vm.toString(_pair(l0, l1)));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
