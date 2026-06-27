// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Settlement} from "../src/Settlement.sol";
import {OperatorStaking} from "../src/OperatorStaking.sol";
import {ISettlement} from "../src/interfaces/ISettlement.sol";
import {IOperatorStaking} from "../src/interfaces/IOperatorStaking.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Shared harness for the M9 redundant-flow tests: deploys + wires Settlement + the isolated
///      OperatorStaking vault + an orchestrator key, and provides the EIP-712 Assignment signer,
///      a sorted-pair Merkle builder (matching Settlement._verifyMembership), and stake/submit
///      helpers. Abstract → not instantiated as a test itself.
abstract contract M9TestBase is Test {
    Settlement internal settlement;
    OperatorStaking internal staking;
    MockUSDC internal usdc;

    address internal treasury = address(0xBEEF);
    address internal buyer = address(0xB0B);

    uint256 internal orchestratorKey = 0x0DECAF;
    address internal orchestrator;

    // committee node keys
    uint256 internal k1 = 0xA11CE;
    uint256 internal k2 = 0xB0B0B0;
    uint256 internal k3 = 0xC0C0C0;
    // an outsider / sybil key (never in any operatorSetRoot)
    uint256 internal kEvil = 0xBADBAD;

    bytes32 internal constant IN_HASH = keccak256("in");

    uint256 internal constant AMOUNT = 100e6; // 100 USDC
    uint256 internal constant BOND = 10e6; // 10 USDC
    uint256 internal constant MIN_STAKE = 10e6; // == BOND so a single stake covers one job
    uint16 internal constant FEE_BPS = 50; // 0.5%

    function setUp() public virtual {
        usdc = new MockUSDC();
        staking = new OperatorStaking(IERC20(address(usdc)), MIN_STAKE, 7 days);
        settlement = new Settlement(IERC20(address(usdc)), treasury, FEE_BPS, true);
        staking.setSlasher(address(settlement));
        settlement.setStaking(IOperatorStaking(address(staking)));
        orchestrator = vm.addr(orchestratorKey);
        settlement.setOrchestrator(orchestrator);
        usdc.mint(buyer, 1_000e6);
    }

    // ----- committee construction -----

    function _committee2() internal view returns (address[] memory c) {
        c = new address[](2);
        c[0] = vm.addr(k1);
        c[1] = vm.addr(k2);
    }

    function _committee3() internal view returns (address[] memory c) {
        c = new address[](3);
        c[0] = vm.addr(k1);
        c[1] = vm.addr(k2);
        c[2] = vm.addr(k3);
    }

    // ----- EIP-712 Assignment (orchestrator-signed) -----

    function _mkEscrow(bytes32 jobId, uint256 amount, uint16 m, uint256 bond, bytes32 root)
        internal
        view
        returns (ISettlement.RedundantEscrow memory e)
    {
        e = ISettlement.RedundantEscrow({
            jobId: jobId,
            amount: amount,
            // 2h > the 1h CHALLENGE_WINDOW, so a post-window claim is still before the deadline.
            deadline: uint64(block.timestamp + 2 hours),
            redundancy: m,
            bond: bond,
            inputHash: IN_HASH,
            operatorSetRoot: root,
            nonce: 1
        });
    }

    function _signAssignment(ISettlement.RedundantEscrow memory e, uint256 key) internal view returns (bytes memory) {
        bytes32 digest = settlement.assignmentDigest(e);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Buyer escrows a redundant job authorized by the orchestrator.
    function _escrowRedundant(ISettlement.RedundantEscrow memory e) internal {
        bytes memory sig = _signAssignment(e, orchestratorKey);
        vm.startPrank(buyer);
        usdc.approve(address(settlement), e.amount);
        settlement.escrowRedundant(e, sig);
        vm.stopPrank();
    }

    // ----- proof signing (node attestation) -----

    function _signProof(bytes32 jobId, bytes32 inHash, bytes32 outHash, uint256 key)
        internal
        view
        returns (ISettlement.ProofBundle memory p)
    {
        p = ISettlement.ProofBundle({
            jobId: jobId, inputHash: inHash, outputHash: outHash, metadata: bytes("meta"), nodeSignature: ""
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.proofDigest(p));
        p.nodeSignature = abi.encodePacked(r, s, v);
    }

    // ----- stake + submit -----

    /// @dev Operator `key` stakes `amount` into the vault.
    function _stake(uint256 key, uint256 amount) internal {
        address op = vm.addr(key);
        usdc.mint(op, amount);
        vm.startPrank(op);
        usdc.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    /// @dev Operator at committee index `idx` stakes BOND then submits `outHash` for `jobId`.
    function _stakeAndSubmit(bytes32 jobId, bytes32 outHash, uint256 key, address[] memory committee, uint256 idx)
        internal
        returns (address op)
    {
        op = vm.addr(key);
        _stake(key, BOND);
        ISettlement.ProofBundle memory p = _signProof(jobId, IN_HASH, outHash, key);
        bytes32[] memory proof = _merkleProof(committee, idx);
        vm.prank(op);
        settlement.submitProof(p, op, proof);
    }

    // ----- sorted-pair Merkle (matches Settlement._verifyMembership; leaf = keccak256(addr)) -----

    function _leaf(address a) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(a));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _merkleRoot(address[] memory ops) internal pure returns (bytes32) {
        bytes32[] memory level = _leaves(ops);
        while (level.length > 1) {
            level = _nextLevel(level);
        }
        return level[0];
    }

    function _merkleProof(address[] memory ops, uint256 idx) internal pure returns (bytes32[] memory proof) {
        bytes32[] memory level = _leaves(ops);
        proof = new bytes32[](0);
        while (level.length > 1) {
            uint256 sib = idx ^ 1;
            if (sib < level.length) {
                proof = _push(proof, level[sib]);
            }
            idx /= 2;
            level = _nextLevel(level);
        }
    }

    function _leaves(address[] memory ops) private pure returns (bytes32[] memory l) {
        l = new bytes32[](ops.length);
        for (uint256 i; i < ops.length; i++) {
            l[i] = _leaf(ops[i]);
        }
    }

    function _nextLevel(bytes32[] memory level) private pure returns (bytes32[] memory next) {
        uint256 n = (level.length + 1) / 2;
        next = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            uint256 li = 2 * i;
            uint256 ri = li + 1;
            next[i] = ri < level.length ? _hashPair(level[li], level[ri]) : level[li];
        }
    }

    function _push(bytes32[] memory arr, bytes32 v) private pure returns (bytes32[] memory out) {
        out = new bytes32[](arr.length + 1);
        for (uint256 i; i < arr.length; i++) {
            out[i] = arr[i];
        }
        out[arr.length] = v;
    }
}
