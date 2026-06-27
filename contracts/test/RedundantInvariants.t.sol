// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {M9TestBase} from "./M9TestBase.sol";
import {ISettlement} from "../src/interfaces/ISettlement.sol";

/// @dev Stateful fuzz handler driving the REAL M9 redundant flow: orchestrator-signed
///      escrowRedundant → Merkle/inputHash-gated submitProof → super-plurality → buyer challenge →
///      window-gated claim/slash → withdrawals. Every action is try/catch'd so wrong-state reverts
///      don't abort the run. Reuses M9TestBase for the Merkle + Assignment-signing + staking helpers.
contract RedundantHandler is M9TestBase {
    bytes32[] internal JOBS;
    address[] internal committee; // [op(k1), op(k2), op(k3)]
    bytes32 internal root;
    bytes32[][3] internal proofs; // membership proof per committee index
    uint256[3] internal opKeys;

    uint256 internal constant STAKE = 100e6; // per operator
    uint256 public constant MINTED = 1_000e6 + 3 * STAKE; // buyer + 3 operator stakes

    constructor() {
        setUp(); // M9TestBase: deploy + wire Settlement+OperatorStaking+orchestrator; mint buyer 1000e6
        opKeys = [k1, k2, k3];
        committee = _committee3();
        root = _merkleRoot(committee);
        for (uint256 i; i < 3; i++) {
            proofs[i] = _merkleProof(committee, i);
            _stake(opKeys[i], STAKE); // mints STAKE to the operator, then stakes it
        }
        for (uint256 i; i < 5; i++) {
            JOBS.push(keccak256(abi.encode("ijob", i)));
        }
    }

    function _ijob(uint256 s) internal view returns (bytes32) {
        return JOBS[s % JOBS.length];
    }

    // Small output space so 2-of-3 consensus AND disagreement (slash) both occur during fuzzing.
    function _iout(uint256 s) internal pure returns (bytes32) {
        return keccak256(abi.encode("o", s % 2));
    }

    function escrowJob(uint256 jSeed, uint256 amtSeed) public {
        uint256 amount = bound(amtSeed, 2, 100e6);
        if (usdc.balanceOf(buyer) < amount) return;
        ISettlement.RedundantEscrow memory e = _mkEscrow(_ijob(jSeed), amount, 3, BOND, root);
        bytes memory sig = _signAssignment(e, orchestratorKey);
        vm.startPrank(buyer);
        usdc.approve(address(settlement), amount);
        try settlement.escrowRedundant(e, sig) {} catch {}
        vm.stopPrank();
    }

    function submit(uint256 jSeed, uint256 opSeed, uint256 outSeed) public {
        uint256 i = opSeed % 3;
        address op = vm.addr(opKeys[i]);
        ISettlement.ProofBundle memory p = _signProof(_ijob(jSeed), IN_HASH, _iout(outSeed), opKeys[i]);
        vm.prank(op);
        try settlement.submitProof(p, op, proofs[i]) {} catch {}
    }

    function challengeJob(uint256 jSeed) public {
        vm.startPrank(buyer);
        usdc.approve(address(settlement), settlement.CHALLENGE_BOND());
        try settlement.challenge(_ijob(jSeed)) {} catch {}
        vm.stopPrank();
    }

    function claimOp(uint256 jSeed, uint256 opSeed) public {
        try settlement.claim(_ijob(jSeed), vm.addr(opKeys[opSeed % 3])) {} catch {}
    }

    function refundJob(uint256 jSeed) public {
        try settlement.refund(_ijob(jSeed)) {} catch {}
    }

    function withdraw(uint256 opSeed) public {
        address op = vm.addr(opKeys[opSeed % 3]);
        vm.prank(op);
        try settlement.withdrawReward() {} catch {}
    }

    function sweepFees() public {
        try settlement.withdrawFees() {} catch {}
    }

    function warpTime(uint256 dt) public {
        vm.warp(block.timestamp + bound(dt, 1, 3 hours));
    }

    /// Sum of USDC across every account funds can reach.
    function sumAll() external view returns (uint256 s) {
        s += usdc.balanceOf(buyer);
        s += usdc.balanceOf(address(settlement));
        s += usdc.balanceOf(address(staking));
        s += usdc.balanceOf(treasury);
        for (uint256 i; i < 3; i++) {
            s += usdc.balanceOf(vm.addr(opKeys[i]));
        }
    }
}

contract RedundantInvariantsTest is StdInvariant, Test {
    RedundantHandler handler;

    function setUp() public {
        handler = new RedundantHandler();
        // Only fuzz the handler's action functions — NOT M9TestBase.setUp() (would redeploy the world).
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = handler.escrowJob.selector;
        selectors[1] = handler.submit.selector;
        selectors[2] = handler.challengeJob.selector;
        selectors[3] = handler.claimOp.selector;
        selectors[4] = handler.refundJob.selector;
        selectors[5] = handler.withdraw.selector;
        selectors[6] = handler.sweepFees.selector;
        selectors[7] = handler.warpTime.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// USDC is never created or destroyed across Settlement + OperatorStaking — the cross-contract
    /// solvency backstop for the M9 redundant flow (escrow/bond/stake/slash/reward/refund net to zero).
    function invariant_redundantConservationOfFunds() public view {
        assertEq(handler.sumAll(), handler.MINTED());
    }
}
