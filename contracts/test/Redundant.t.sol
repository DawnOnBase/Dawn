// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {M9TestBase} from "./M9TestBase.sol";
import {Settlement} from "../src/Settlement.sol";
import {OperatorStaking} from "../src/OperatorStaking.sol";
import {ISettlement} from "../src/interfaces/ISettlement.sol";
import {IOperatorStaking} from "../src/interfaces/IOperatorStaking.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev M9 redundant-execution state machine: orchestrator-attested escrow → membership-gated
///      submit → super-plurality → challenge window → claim/slash. Plus cross-contract conservation.
contract RedundantTest is M9TestBase {
    uint64 internal constant WINDOW = 1 hours; // == Settlement.CHALLENGE_WINDOW

    function _st(bytes32 jobId) internal view returns (uint8) {
        return uint8(settlement.jobStatus(jobId));
    }

    // ---- happy path: consensus → pending → window → claim ----

    function test_consensus_pendingThenClaimAfterWindow() public {
        bytes32 jobId = keccak256("r-happy");
        address[] memory c = _committee2();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 2, BOND, _merkleRoot(c)));
        bytes32 outHash = keccak256("result");

        address n1 = _stakeAndSubmit(jobId, outHash, k1, c, 0);
        assertEq(_st(jobId), uint8(ISettlement.JobStatus.Escrowed)); // 1/2, not yet
        address n2 = _stakeAndSubmit(jobId, outHash, k2, c, 1);
        assertEq(_st(jobId), uint8(ISettlement.JobStatus.PendingConsensus)); // quorum reached

        // No payout during the window.
        vm.expectRevert(bytes("CHALLENGE_OPEN"));
        settlement.claim(jobId, n1);

        vm.warp(block.timestamp + WINDOW + 1);
        settlement.claim(jobId, n1);
        settlement.claim(jobId, n2);

        // Bond released to free stake on claim; reward is pull-based (swept by the winner).
        assertEq(staking.freeStake(n1), BOND);
        assertEq(staking.freeStake(n2), BOND);
        vm.prank(n1);
        settlement.withdrawReward();
        vm.prank(n2);
        settlement.withdrawReward();
        // perWinner = (100e6 - 0.5e6) / 2 = 49.75e6
        assertEq(usdc.balanceOf(n1), 49_750_000);
        assertEq(usdc.balanceOf(n2), 49_750_000);
        assertEq(settlement.accruedFees(), 500_000); // fee realized only now
        settlement.withdrawFees();
        assertEq(usdc.balanceOf(treasury), 500_000);
        assertEq(usdc.balanceOf(address(settlement)), 0);
    }

    // ---- super-plurality: 2-of-3 reaches consensus despite a dissenter; loser slashed ----

    function test_superPlurality_consensusAndSlash() public {
        bytes32 jobId = keccak256("r-3");
        address[] memory c = _committee3();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 3, BOND, _merkleRoot(c)));
        bytes32 good = keccak256("good");
        bytes32 bad = keccak256("bad");

        address loser = _stakeAndSubmit(jobId, bad, k3, c, 2); // dissenter submits first
        address n1 = _stakeAndSubmit(jobId, good, k1, c, 0);
        assertEq(_st(jobId), uint8(ISettlement.JobStatus.Escrowed)); // good=1, bad=1
        address n2 = _stakeAndSubmit(jobId, good, k2, c, 1); // good=2 == quorum(3)=2
        assertEq(_st(jobId), uint8(ISettlement.JobStatus.PendingConsensus));

        vm.warp(block.timestamp + WINDOW + 1);
        settlement.claim(jobId, loser); // wrong hash → bond slashed
        settlement.claim(jobId, n1);
        settlement.claim(jobId, n2);
        vm.prank(n1);
        settlement.withdrawReward();
        vm.prank(n2);
        settlement.withdrawReward();

        assertEq(usdc.balanceOf(n1), 49_750_000);
        assertEq(usdc.balanceOf(n2), 49_750_000);
        assertEq(staking.freeStake(loser), 0); // bond gone
        assertEq(staking.lockedStake(loser), 0);
        assertEq(settlement.accruedFees(), 500_000 + BOND); // fee + slashed bond

        _assertConservation(_threeNodes(n1, n2, loser));
    }

    // ---- challenge voids consensus: refund + bonds back, NO slash (defends A2) ----

    function test_challenge_voidsRefundsAndReturnsBonds() public {
        bytes32 jobId = keccak256("r-challenge");
        address[] memory c = _committee2();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 2, BOND, _merkleRoot(c)));
        bytes32 outHash = keccak256("result");
        address n1 = _stakeAndSubmit(jobId, outHash, k1, c, 0);
        address n2 = _stakeAndSubmit(jobId, outHash, k2, c, 1);
        assertEq(_st(jobId), uint8(ISettlement.JobStatus.PendingConsensus));

        // Buyer challenges within the window, forfeiting the (non-refundable v1) CHALLENGE_BOND.
        uint256 fee = settlement.CHALLENGE_BOND();
        vm.warp(block.timestamp + 30 minutes);
        vm.startPrank(buyer);
        usdc.approve(address(settlement), fee);
        settlement.challenge(jobId);
        vm.stopPrank();
        assertEq(_st(jobId), uint8(ISettlement.JobStatus.Challenged));

        // Escrow refunds in full; only the forfeited challenge fee accrues to the treasury.
        settlement.refund(jobId);
        assertEq(usdc.balanceOf(buyer), 1_000e6 - fee);
        assertEq(settlement.accruedFees(), fee);

        // Bonds returned, never slashed.
        settlement.claim(jobId, n1);
        settlement.claim(jobId, n2);
        assertEq(usdc.balanceOf(n1), 0);
        assertEq(usdc.balanceOf(n2), 0);
        assertEq(staking.freeStake(n1), BOND);
        assertEq(staking.freeStake(n2), BOND);
        assertEq(usdc.balanceOf(address(settlement)), fee); // forfeited fee, until withdrawFees

        address[] memory ns = new address[](2);
        ns[0] = n1;
        ns[1] = n2;
        _assertConservation(ns);
    }

    // L3: a winner with a blacklisted/reverting payout address still recovers its bond and the
    // reward stays claimable (pull-based) — claim() never reverts on the payout.
    function test_winner_blacklistedPayout_stillRecoversBondAndReward() public {
        bytes32 jobId = keccak256("r-blacklist-winner");
        address[] memory c = _committee2();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 2, BOND, _merkleRoot(c)));
        bytes32 outHash = keccak256("result");
        address n1 = _stakeAndSubmit(jobId, outHash, k1, c, 0);
        address n2 = _stakeAndSubmit(jobId, outHash, k2, c, 1);

        usdc.setBlacklist(n1, true); // n1 cannot receive USDC
        vm.warp(block.timestamp + WINDOW + 1);

        settlement.claim(jobId, n1); // succeeds despite the blacklist — bond released, reward credited
        assertEq(staking.freeStake(n1), BOND);
        assertEq(settlement.withdrawableReward(n1), 49_750_000);

        vm.prank(n1);
        vm.expectRevert(bytes("BLACKLISTED")); // only the sweep is blocked
        settlement.withdrawReward();

        usdc.setBlacklist(n1, false);
        vm.prank(n1);
        settlement.withdrawReward();
        assertEq(usdc.balanceOf(n1), 49_750_000);
    }

    function test_challenge_revertsWithoutFee() public {
        bytes32 jobId = keccak256("r-chal-nofee");
        address[] memory c = _committee2();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 2, BOND, _merkleRoot(c)));
        _stakeAndSubmit(jobId, keccak256("x"), k1, c, 0);
        _stakeAndSubmit(jobId, keccak256("x"), k2, c, 1);
        // Buyer has not approved the CHALLENGE_BOND → the fee pull reverts.
        vm.prank(buyer);
        vm.expectRevert();
        settlement.challenge(jobId);
    }

    // ---- no consensus by the deadline: refund + bonds back ----

    function test_noConsensus_refundAndReturnBonds() public {
        bytes32 jobId = keccak256("r-noconsensus");
        address[] memory c = _committee3();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 3, BOND, _merkleRoot(c)));
        // Two distinct hashes → no hash reaches quorum(=2).
        address n1 = _stakeAndSubmit(jobId, keccak256("a"), k1, c, 0);
        address n2 = _stakeAndSubmit(jobId, keccak256("b"), k2, c, 1);
        assertEq(_st(jobId), uint8(ISettlement.JobStatus.Escrowed));

        // Claim before finality reverts.
        vm.expectRevert(bytes("NOT_FINAL"));
        settlement.claim(jobId, n1);

        vm.warp(block.timestamp + 3 hours); // past deadline
        settlement.refund(jobId);
        assertEq(usdc.balanceOf(buyer), 1_000e6);

        settlement.claim(jobId, n1);
        settlement.claim(jobId, n2);
        assertEq(staking.freeStake(n1), BOND);
        assertEq(staking.freeStake(n2), BOND);
        assertEq(settlement.accruedFees(), 0); // nothing slashed
    }

    // A submitter can reclaim its bond after the deadline even if the buyer never calls refund
    // (job stays Escrowed; no consensus formed).
    function test_claim_noConsensus_afterDeadline_withoutRefund() public {
        bytes32 jobId = keccak256("r-deadbond");
        address[] memory c = _committee3();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 3, BOND, _merkleRoot(c)));
        address n1 = _stakeAndSubmit(jobId, keccak256("solo"), k1, c, 0); // 1/3, never reaches quorum
        assertEq(_st(jobId), uint8(ISettlement.JobStatus.Escrowed));

        vm.warp(block.timestamp + 3 hours); // past deadline, buyer has NOT refunded
        settlement.claim(jobId, n1);
        assertEq(staking.freeStake(n1), BOND); // bond returned, not slashed
        assertEq(settlement.accruedFees(), 0);
    }

    // ---- guards ----

    function test_challenge_onlyBuyerWithinWindow() public {
        bytes32 jobId = keccak256("r-chal-guard");
        address[] memory c = _committee2();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 2, BOND, _merkleRoot(c)));
        _stakeAndSubmit(jobId, keccak256("x"), k1, c, 0);
        _stakeAndSubmit(jobId, keccak256("x"), k2, c, 1);

        vm.prank(address(0xDEAD));
        vm.expectRevert(bytes("NOT_CHALLENGER"));
        settlement.challenge(jobId);

        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(buyer);
        vm.expectRevert(bytes("WINDOW_CLOSED"));
        settlement.challenge(jobId);
    }

    function test_challenge_revertsIfNotPending() public {
        bytes32 jobId = keccak256("r-chal-notpending");
        address[] memory c = _committee2();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 2, BOND, _merkleRoot(c)));
        _stakeAndSubmit(jobId, keccak256("x"), k1, c, 0); // only 1/2, still Escrowed
        vm.prank(buyer);
        vm.expectRevert(bytes("NOT_PENDING"));
        settlement.challenge(jobId);
    }

    function test_submitAfterConsensus_reverts() public {
        bytes32 jobId = keccak256("r-frozen");
        address[] memory c = _committee3();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 3, BOND, _merkleRoot(c)));
        _stakeAndSubmit(jobId, keccak256("x"), k1, c, 0);
        _stakeAndSubmit(jobId, keccak256("x"), k2, c, 1); // consensus frozen

        // A late authorized member can no longer submit.
        address late = vm.addr(k3);
        _stake(k3, BOND);
        ISettlement.ProofBundle memory p = _signProof(jobId, IN_HASH, keccak256("x"), k3);
        bytes32[] memory proof = _merkleProof(c, 2);
        vm.prank(late);
        vm.expectRevert(bytes("NOT_ESCROWED"));
        settlement.submitProof(p, late, proof);
    }

    function test_doubleSubmit_reverts() public {
        bytes32 jobId = keccak256("r-double");
        address[] memory c = _committee3();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 3, BOND, _merkleRoot(c)));
        _stakeAndSubmit(jobId, keccak256("x"), k1, c, 0);

        ISettlement.ProofBundle memory p = _signProof(jobId, IN_HASH, keccak256("y"), k1);
        bytes32[] memory proof = _merkleProof(c, 0);
        vm.prank(vm.addr(k1));
        vm.expectRevert(bytes("ALREADY_SUBMITTED"));
        settlement.submitProof(p, vm.addr(k1), proof);
    }

    function test_submit_revertsAfterDeadline() public {
        bytes32 jobId = keccak256("r-expired");
        address[] memory c = _committee2();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 2, BOND, _merkleRoot(c)));
        _stake(k1, BOND);
        vm.warp(block.timestamp + 3 hours); // past deadline
        ISettlement.ProofBundle memory p = _signProof(jobId, IN_HASH, keccak256("x"), k1);
        bytes32[] memory proof = _merkleProof(c, 0);
        vm.prank(vm.addr(k1));
        vm.expectRevert(bytes("EXPIRED"));
        settlement.submitProof(p, vm.addr(k1), proof);
    }

    function test_settle_revertsForRedundantJob() public {
        bytes32 jobId = keccak256("r-usesubmit");
        address[] memory c = _committee2();
        _escrowRedundant(_mkEscrow(jobId, AMOUNT, 2, BOND, _merkleRoot(c)));
        ISettlement.ProofBundle memory p = _signProof(jobId, IN_HASH, keccak256("x"), k1);
        vm.expectRevert(bytes("USE_SUBMIT_PROOF"));
        settlement.settle(p, vm.addr(k1));
    }

    function test_submitProof_revertsForSingleNodeJob() public {
        bytes32 jobId = keccak256("single");
        vm.startPrank(buyer);
        usdc.approve(address(settlement), AMOUNT);
        settlement.escrow(jobId, AMOUNT, uint64(block.timestamp + 1 hours));
        vm.stopPrank();
        _stake(k1, BOND);
        ISettlement.ProofBundle memory p = _signProof(jobId, IN_HASH, keccak256("x"), k1);
        bytes32[] memory empty = new bytes32[](0);
        vm.prank(vm.addr(k1));
        vm.expectRevert(bytes("NOT_REDUNDANT"));
        settlement.submitProof(p, vm.addr(k1), empty);
    }

    // ---- escrowRedundant guards ----

    function test_escrowRedundant_revertsWhenDisabled() public {
        Settlement disabled = new Settlement(IERC20(address(usdc)), treasury, FEE_BPS, false);
        ISettlement.RedundantEscrow memory e = _mkEscrow(keccak256("d"), AMOUNT, 2, BOND, keccak256("root"));
        bytes memory sig = _signAssignment(e, orchestratorKey); // wrong contract, but the gate hits first
        vm.prank(buyer);
        vm.expectRevert(bytes("REDUNDANT_DISABLED"));
        disabled.escrowRedundant(e, sig);
    }

    function test_escrowRedundant_revertsWhenNotConfigured() public {
        // redundant enabled but no orchestrator/staking wired.
        Settlement bare = new Settlement(IERC20(address(usdc)), treasury, FEE_BPS, true);
        ISettlement.RedundantEscrow memory e = _mkEscrow(keccak256("b"), AMOUNT, 2, BOND, keccak256("root"));
        vm.prank(buyer);
        vm.expectRevert(bytes("M9_NOT_CONFIGURED"));
        bare.escrowRedundant(e, hex"00");
    }

    function test_escrowRedundant_revertsBelowMinBond() public {
        ISettlement.RedundantEscrow memory e = _mkEscrow(keccak256("lowbond"), AMOUNT, 2, 1, _merkleRoot(_committee2()));
        bytes memory sig = _signAssignment(e, orchestratorKey);
        vm.startPrank(buyer);
        usdc.approve(address(settlement), AMOUNT);
        vm.expectRevert(bytes("BOND_TOO_LOW"));
        settlement.escrowRedundant(e, sig);
        vm.stopPrank();
    }

    function test_escrowRedundant_revertsAboveCap() public {
        settlement.setMaxRedundantAmount(50e6);
        ISettlement.RedundantEscrow memory e =
            _mkEscrow(keccak256("capped"), AMOUNT, 2, BOND, _merkleRoot(_committee2()));
        bytes memory sig = _signAssignment(e, orchestratorKey);
        vm.startPrank(buyer);
        usdc.approve(address(settlement), AMOUNT);
        vm.expectRevert(bytes("AMOUNT_CAPPED"));
        settlement.escrowRedundant(e, sig);
        vm.stopPrank();
    }

    function test_escrowRedundant_revertsRedundancyOne() public {
        ISettlement.RedundantEscrow memory e = _mkEscrow(keccak256("r1"), AMOUNT, 1, BOND, _merkleRoot(_committee2()));
        bytes memory sig = _signAssignment(e, orchestratorKey);
        vm.startPrank(buyer);
        usdc.approve(address(settlement), AMOUNT);
        vm.expectRevert(bytes("USE_ESCROW"));
        settlement.escrowRedundant(e, sig);
        vm.stopPrank();
    }

    // ---- conservation fuzz (Settlement + OperatorStaking) ----

    function testFuzz_redundant_conserves(uint96 amount) public {
        uint256 amt = bound(amount, 2, 500e6);
        bytes32 jobId = keccak256(abi.encode("rfuzz", amt));
        address[] memory c = _committee2();
        _escrowRedundant(_mkEscrow(jobId, amt, 2, BOND, _merkleRoot(c)));
        address n1 = _stakeAndSubmit(jobId, keccak256("r"), k1, c, 0);
        address n2 = _stakeAndSubmit(jobId, keccak256("r"), k2, c, 1);
        vm.warp(block.timestamp + WINDOW + 1);
        settlement.claim(jobId, n1);
        settlement.claim(jobId, n2);
        vm.prank(n1);
        settlement.withdrawReward();
        vm.prank(n2);
        settlement.withdrawReward();

        address[] memory ns = new address[](2);
        ns[0] = n1;
        ns[1] = n2;
        _assertConservation(ns);
        // escrow fully distributed: rewards + fee == amount
        uint256 rewards = usdc.balanceOf(n1) + usdc.balanceOf(n2);
        assertEq(rewards + settlement.accruedFees(), amt);
    }

    // L1 regression: the orchestrator Assignment now binds `amount`, so a buyer cannot underpay an
    // authorized committee by escrowing a different amount than was signed.
    function test_escrowRedundant_revertsIfAmountMutatedAfterSigning() public {
        ISettlement.RedundantEscrow memory e = _mkEscrow(keccak256("amt"), AMOUNT, 2, BOND, _merkleRoot(_committee2()));
        bytes memory sig = _signAssignment(e, orchestratorKey); // signed for AMOUNT
        e.amount = 1; // buyer tries to underpay the committee to dust
        vm.startPrank(buyer);
        usdc.approve(address(settlement), AMOUNT);
        vm.expectRevert(bytes("BAD_ASSIGNMENT"));
        settlement.escrowRedundant(e, sig);
        vm.stopPrank();
    }

    // ---- helpers ----

    function _threeNodes(address a, address b, address d) internal pure returns (address[] memory ns) {
        ns = new address[](3);
        ns[0] = a;
        ns[1] = b;
        ns[2] = d;
    }

    /// @dev Total USDC is conserved across {buyer, settlement, staking, treasury, nodes}. The total
    ///      minted is buyer's 1000e6 + BOND per staked node.
    function _assertConservation(address[] memory nodes) internal view {
        uint256 sum = usdc.balanceOf(buyer) + usdc.balanceOf(address(settlement)) + usdc.balanceOf(address(staking))
            + usdc.balanceOf(treasury);
        for (uint256 i; i < nodes.length; i++) {
            sum += usdc.balanceOf(nodes[i]);
        }
        assertEq(sum, 1_000e6 + nodes.length * BOND);
    }
}
