// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {M9TestBase} from "./M9TestBase.sol";
import {ISettlement} from "../src/interfaces/ISettlement.sol";

/// @dev Proof-of-defense for the five attacks in contracts/SECURITY.md's 🔴 finding, now closed by
///      the M9 redesign (the redundant-execution design). Each test drives the attack and asserts it
///      reverts / is neutralized. Naming: A1 Sybil, A2 honest-slash, A3 copy/free-rider, A4 zero-bond,
///      A5 wrong-input. Plus orchestrator-signature forgery and Merkle membership.
contract PoCSybilSlashTest is M9TestBase {
    uint64 internal constant WINDOW = 1 hours;

    function _st(bytes32 jobId) internal view returns (uint8) {
        return uint8(settlement.jobStatus(jobId));
    }

    // ── A1: a Sybil with throwaway keys cannot occupy a committee seat ──────────────────────────
    function test_A1_sybilKeyNotAuthorized() public {
        bytes32 jobId = keccak256("a1");
        address[] memory c = _committee2(); // authorized set = {k1, k2}
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 2, BOND, _merkleRoot(c)));

        // The attacker controls kEvil (a throwaway key) — NOT in operatorSetRoot. A validly-signed
        // proof + a fabricated Merkle path still fails authorization, so it cannot add a vote.
        address evil = vm.addr(kEvil);
        _stake(kEvil, BOND); // even with stake, authorization is the gate
        ISettlement.ProofBundle memory p = _signProof(jobId, IN_HASH, keccak256("fake"), kEvil);
        bytes32[] memory bogus = _merkleProof(c, 0); // some real path, wrong leaf
        vm.prank(evil);
        vm.expectRevert(bytes("NOT_AUTHORIZED"));
        settlement.submitProof(p, evil, bogus);
    }

    // ── A3: copying a victim's outputHash off-chain earns nothing (not authorized) ──────────────
    function test_A3_copyOutputHashFreeRiderBlocked() public {
        bytes32 jobId = keccak256("a3");
        address[] memory c = _committee2();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 2, BOND, _merkleRoot(c)));
        bytes32 winning = keccak256("winning");
        _stakeAndSubmit(jobId, winning, k1, c, 0); // attacker observes this outputHash in the event

        // Free-rider copies `winning` but is outside the committee → NOT_AUTHORIZED.
        address evil = vm.addr(kEvil);
        _stake(kEvil, BOND);
        ISettlement.ProofBundle memory p = _signProof(jobId, IN_HASH, winning, kEvil);
        bytes32[] memory bogus = _merkleProof(c, 1);
        vm.prank(evil);
        vm.expectRevert(bytes("NOT_AUTHORIZED"));
        settlement.submitProof(p, evil, bogus);
    }

    // ── A4: a zero (or sub-minimum) bond is rejected at escrow ──────────────────────────────────
    function test_A4_zeroBondRejected() public {
        ISettlement.RedundantEscrow memory e = _mkEscrow(keccak256("a4"), AMOUNT, 2, 0, _merkleRoot(_committee2()));
        bytes memory sig = _signAssignment(e, orchestratorKey);
        vm.startPrank(buyer);
        usdc.approve(address(settlement), AMOUNT);
        vm.expectRevert(bytes("BOND_TOO_LOW"));
        settlement.escrowRedundant(e, sig);
        vm.stopPrank();
    }

    // ── A5: consensus cannot form on a different input than the buyer paid for ───────────────────
    function test_A5_wrongInputRejected() public {
        bytes32 jobId = keccak256("a5");
        address[] memory c = _committee2();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 2, BOND, _merkleRoot(c))); // pins inputHash = IN_HASH

        // An authorized member signs a proof over a DIFFERENT inputHash → INPUT_MISMATCH.
        address n1 = vm.addr(k1);
        _stake(k1, BOND);
        ISettlement.ProofBundle memory p = _signProof(jobId, keccak256("evil-input"), keccak256("out"), k1);
        bytes32[] memory proof = _merkleProof(c, 0);
        vm.prank(n1);
        vm.expectRevert(bytes("INPUT_MISMATCH"));
        settlement.submitProof(p, n1, proof);
    }

    // ── A2: an honest dissenter is protected from a wrong-consensus slash by the buyer challenge ──
    function test_A2_honestNodeProtectedByChallenge() public {
        bytes32 jobId = keccak256("a2-defended");
        address[] memory c = _committee3();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 3, BOND, _merkleRoot(c)));

        // Honest k3 submits the correct result first; then the malicious majority {k1,k2} out-votes
        // it to reach quorum on a WRONG hash — leaving honest k3 as a slashable "loser".
        address honest = _stakeAndSubmit(jobId, keccak256("CORRECT"), k3, c, 2);
        _stakeAndSubmit(jobId, keccak256("WRONG"), k1, c, 0);
        _stakeAndSubmit(jobId, keccak256("WRONG"), k2, c, 1); // consensus on WRONG
        assertEq(_st(jobId), uint8(ISettlement.JobStatus.PendingConsensus));

        // The buyer (via its watchtower) detects the bad result and challenges within the window,
        // forfeiting the flat CHALLENGE_BOND fee.
        uint256 fee = settlement.CHALLENGE_BOND();
        vm.warp(block.timestamp + 10 minutes);
        vm.startPrank(buyer);
        usdc.approve(address(settlement), fee);
        settlement.challenge(jobId);
        vm.stopPrank();

        // The honest node reclaims its bond — NOT slashed.
        settlement.claim(jobId, honest);
        assertEq(staking.freeStake(honest), BOND);
        assertEq(settlement.accruedFees(), fee); // only the challenge fee, no slash
    }

    // ── A2 residual: WITHOUT a challenge, the minority-correct node IS slashed (documents the trust) ─
    function test_A2_withoutChallenge_honestSlashed() public {
        bytes32 jobId = keccak256("a2-residual");
        address[] memory c = _committee3();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 3, BOND, _merkleRoot(c)));
        address honest = _stakeAndSubmit(jobId, keccak256("CORRECT"), k3, c, 2); // honest submits first
        _stakeAndSubmit(jobId, keccak256("WRONG"), k1, c, 0);
        _stakeAndSubmit(jobId, keccak256("WRONG"), k2, c, 1); // majority out-votes → consensus on WRONG

        // No challenge → window closes → the (correct-but-minority) node is slashed. This is the
        // explicit Phase-1 trust assumption: the buyer/watchtower MUST challenge a wrong consensus.
        vm.warp(block.timestamp + WINDOW + 1);
        settlement.claim(jobId, honest);
        assertEq(staking.freeStake(honest), 0);
        assertEq(settlement.accruedFees(), 500_000 + BOND); // fee + slashed honest bond
    }

    // ── orchestrator-signature forgery: only the orchestrator can authorize a committee ──────────
    function test_orchestratorForgery_rejected() public {
        ISettlement.RedundantEscrow memory e =
            _mkEscrow(keccak256("forge"), AMOUNT, 2, BOND, _merkleRoot(_committee2()));
        bytes memory forged = _signAssignment(e, kEvil); // signed by a non-orchestrator key
        vm.startPrank(buyer);
        usdc.approve(address(settlement), AMOUNT);
        vm.expectRevert(bytes("BAD_ASSIGNMENT"));
        settlement.escrowRedundant(e, forged);
        vm.stopPrank();
    }

    // ── tampered assignment: a sig over a different committee root doesn't validate the swapped one ─
    function test_tamperedAssignmentRoot_rejected() public {
        ISettlement.RedundantEscrow memory signed =
            _mkEscrow(keccak256("tamper"), AMOUNT, 2, BOND, _merkleRoot(_committee2()));
        bytes memory sig = _signAssignment(signed, orchestratorKey);
        // Buyer swaps in a self-serving operator set after getting the signature.
        ISettlement.RedundantEscrow memory tampered = signed;
        tampered.operatorSetRoot = keccak256("attacker-controlled-set");
        vm.startPrank(buyer);
        usdc.approve(address(settlement), AMOUNT);
        vm.expectRevert(bytes("BAD_ASSIGNMENT"));
        settlement.escrowRedundant(tampered, sig);
        vm.stopPrank();
    }

    // ── Merkle: an authorized member with the WRONG proof fails; with the right proof succeeds ───
    function test_merkleMembership_wrongProofRejected() public {
        bytes32 jobId = keccak256("merkle");
        address[] memory c = _committee3();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 3, BOND, _merkleRoot(c)));
        address n1 = vm.addr(k1);
        _stake(k1, BOND);
        ISettlement.ProofBundle memory p = _signProof(jobId, IN_HASH, keccak256("x"), k1);
        // k1 is index 0, but we pass index 2's proof → membership fails.
        bytes32[] memory wrong = _merkleProof(c, 2);
        vm.prank(n1);
        vm.expectRevert(bytes("NOT_AUTHORIZED"));
        settlement.submitProof(p, n1, wrong);

        // Correct proof for index 0 succeeds.
        bytes32[] memory right = _merkleProof(c, 0);
        vm.prank(n1);
        settlement.submitProof(p, n1, right);
        assertEq(staking.lockedStake(n1), BOND);
    }
}
