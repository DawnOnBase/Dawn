// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Settlement} from "../src/Settlement.sol";
import {ISettlement} from "../src/interfaces/ISettlement.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract SettlementTest is Test {
    Settlement settlement;
    MockUSDC usdc;

    address treasury = address(0xBEEF);
    address buyer = address(0xB0B);

    uint256 nodeKey = 0xA11CE;
    address node;

    uint256 constant AMOUNT = 100e6; // 100 USDC (6 dp)
    uint16 constant FEE_BPS = 50; // 0.5%

    function setUp() public {
        usdc = new MockUSDC();
        // The M9 redundant flow lives in Redundant.t.sol / PoCSybilSlash.t.sol (it needs the staking
        // vault + orchestrator wired). This suite is the single-node + admin surface; redundant
        // enabled here only to prove the single-node guards still hold when it's on.
        settlement = new Settlement(IERC20(address(usdc)), treasury, FEE_BPS, true);
        node = vm.addr(nodeKey);
        usdc.mint(buyer, 1_000e6);
    }

    // --- helpers ---

    function _escrow(bytes32 jobId, uint256 amount) internal {
        vm.startPrank(buyer);
        usdc.approve(address(settlement), amount);
        settlement.escrow(jobId, amount, uint64(block.timestamp + 1 hours));
        vm.stopPrank();
    }

    function _signProof(bytes32 jobId, bytes32 inHash, bytes32 outHash, bytes memory meta, uint256 key)
        internal
        view
        returns (ISettlement.ProofBundle memory p)
    {
        p = ISettlement.ProofBundle({
            jobId: jobId, inputHash: inHash, outputHash: outHash, metadata: meta, nodeSignature: ""
        });
        bytes32 digest = settlement.proofDigest(p);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        p.nodeSignature = abi.encodePacked(r, s, v);
    }

    function _status(bytes32 jobId) internal view returns (uint8) {
        return uint8(settlement.jobStatus(jobId));
    }

    // ============================ single-node ============================

    function test_escrow_locksFunds() public {
        bytes32 jobId = keccak256("job-1");
        _escrow(jobId, AMOUNT);
        assertEq(_status(jobId), uint8(ISettlement.JobStatus.Escrowed));
        assertEq(usdc.balanceOf(address(settlement)), AMOUNT);
    }

    function test_refund_afterDeadline() public {
        bytes32 jobId = keccak256("job-2");
        _escrow(jobId, AMOUNT);
        vm.warp(block.timestamp + 2 hours);
        settlement.refund(jobId);
        assertEq(usdc.balanceOf(buyer), 1_000e6);
        assertEq(_status(jobId), uint8(ISettlement.JobStatus.Refunded));
    }

    function test_refund_revertsBeforeDeadline() public {
        bytes32 jobId = keccak256("job-3");
        _escrow(jobId, AMOUNT);
        vm.expectRevert(bytes("NOT_EXPIRED"));
        settlement.refund(jobId);
    }

    function test_settle_paysOperatorAndFee() public {
        bytes32 jobId = keccak256("job-settle");
        _escrow(jobId, AMOUNT);
        ISettlement.ProofBundle memory p = _signProof(jobId, keccak256("in"), keccak256("out"), bytes("meta"), nodeKey);

        settlement.settle(p, node);

        assertEq(usdc.balanceOf(node), 99_500_000);
        // fee accrues (pull-based) until withdrawn
        assertEq(settlement.accruedFees(), 500_000);
        assertEq(usdc.balanceOf(treasury), 0);
        settlement.withdrawFees();
        assertEq(usdc.balanceOf(treasury), 500_000);
        assertEq(usdc.balanceOf(address(settlement)), 0);
        assertEq(_status(jobId), uint8(ISettlement.JobStatus.Settled));
    }

    function test_settle_revertsAfterDeadline() public {
        bytes32 jobId = keccak256("job-late");
        _escrow(jobId, AMOUNT);
        ISettlement.ProofBundle memory p = _signProof(jobId, keccak256("in"), keccak256("out"), bytes("meta"), nodeKey);
        vm.warp(block.timestamp + 2 hours); // past the 1h deadline
        vm.expectRevert(bytes("EXPIRED"));
        settlement.settle(p, node);
    }

    function test_settle_worksWithBlacklistedTreasury() public {
        // DoS fix: a blacklisted treasury must not block the operator's payout.
        bytes32 jobId = keccak256("job-blacklist");
        _escrow(jobId, AMOUNT);
        usdc.setBlacklist(treasury, true);
        ISettlement.ProofBundle memory p = _signProof(jobId, keccak256("in"), keccak256("out"), bytes("meta"), nodeKey);

        settlement.settle(p, node); // succeeds despite the bad treasury
        assertEq(usdc.balanceOf(node), 99_500_000);
        assertEq(settlement.accruedFees(), 500_000);

        vm.expectRevert(bytes("BLACKLISTED")); // only the sweep is blocked, not settlement
        settlement.withdrawFees();
    }

    function test_escrow_revertsIfDeadlineTooFar() public {
        bytes32 jobId = keccak256("job-far");
        vm.startPrank(buyer);
        usdc.approve(address(settlement), AMOUNT);
        vm.expectRevert(bytes("DEADLINE_TOO_FAR"));
        settlement.escrow(jobId, AMOUNT, uint64(block.timestamp + 91 days));
        vm.stopPrank();
    }

    function test_settle_revertsOnWrongOperator() public {
        bytes32 jobId = keccak256("job-wrong-op");
        _escrow(jobId, AMOUNT);
        ISettlement.ProofBundle memory p = _signProof(jobId, keccak256("in"), keccak256("out"), bytes("meta"), nodeKey);
        vm.expectRevert(bytes("BAD_PROOF"));
        settlement.settle(p, address(0xDEAD));
    }

    function test_settle_revertsOnTamperedProof() public {
        bytes32 jobId = keccak256("job-tamper");
        _escrow(jobId, AMOUNT);
        ISettlement.ProofBundle memory p = _signProof(jobId, keccak256("in"), keccak256("out"), bytes("meta"), nodeKey);
        p.outputHash = keccak256("tampered-after-signing");
        vm.expectRevert(bytes("BAD_PROOF"));
        settlement.settle(p, node);
    }

    function test_settle_revertsOnWrongSigner() public {
        bytes32 jobId = keccak256("job-imposter");
        _escrow(jobId, AMOUNT);
        ISettlement.ProofBundle memory p = _signProof(jobId, keccak256("in"), keccak256("out"), bytes("meta"), 0xBADBAD);
        vm.expectRevert(bytes("BAD_PROOF"));
        settlement.settle(p, node);
    }

    function test_settle_revertsOnBadSignatureLength() public {
        bytes32 jobId = keccak256("job-badlen");
        _escrow(jobId, AMOUNT);
        ISettlement.ProofBundle memory p = _signProof(jobId, keccak256("in"), keccak256("out"), bytes("meta"), nodeKey);
        p.nodeSignature = hex"1234"; // not 65 bytes -> _recover returns address(0)
        vm.expectRevert(bytes("BAD_PROOF"));
        settlement.settle(p, node);
    }

    function test_settle_revertsOnBadV() public {
        bytes32 jobId = keccak256("job-badv");
        _escrow(jobId, AMOUNT);
        ISettlement.ProofBundle memory p = _signProof(jobId, keccak256("in"), keccak256("out"), bytes("meta"), nodeKey);
        p.nodeSignature[64] = bytes1(uint8(29)); // v not in {27,28}
        vm.expectRevert(bytes("BAD_PROOF"));
        settlement.settle(p, node);
    }

    function test_settle_revertsOnHighS() public {
        bytes32 jobId = keccak256("job-highs");
        _escrow(jobId, AMOUNT);
        ISettlement.ProofBundle memory p = _signProof(jobId, keccak256("in"), keccak256("out"), bytes("meta"), nodeKey);
        bytes memory sig = p.nodeSignature;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        // malleable high-s counterpart: s' = n - s, with v flipped — the contract must still reject.
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(n - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        p.nodeSignature = abi.encodePacked(r, highS, flippedV);
        vm.expectRevert(bytes("BAD_PROOF"));
        settlement.settle(p, node);
    }

    function test_settle_cannotDoubleSettle() public {
        bytes32 jobId = keccak256("job-double");
        _escrow(jobId, AMOUNT);
        ISettlement.ProofBundle memory p = _signProof(jobId, keccak256("in"), keccak256("out"), bytes("meta"), nodeKey);
        settlement.settle(p, node);
        vm.expectRevert(bytes("NOT_ESCROWED"));
        settlement.settle(p, node);
    }

    function test_settle_revertsOnUnknownJob() public {
        bytes32 jobId = keccak256("never-escrowed");
        ISettlement.ProofBundle memory p = _signProof(jobId, keccak256("in"), keccak256("out"), bytes("meta"), nodeKey);
        vm.expectRevert(bytes("NOT_ESCROWED"));
        settlement.settle(p, node);
    }

    function test_refund_revertsAfterSettle() public {
        bytes32 jobId = keccak256("job-settle-then-refund");
        _escrow(jobId, AMOUNT);
        ISettlement.ProofBundle memory p = _signProof(jobId, keccak256("in"), keccak256("out"), bytes("meta"), nodeKey);
        settlement.settle(p, node);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(bytes("NOT_ESCROWED"));
        settlement.refund(jobId);
    }

    function testFuzz_settle_conservesFunds(uint96 amount) public {
        amount = uint96(bound(amount, 1, 1_000e6));
        bytes32 jobId = keccak256(abi.encode("fuzz", amount));
        usdc.mint(buyer, amount);
        vm.startPrank(buyer);
        usdc.approve(address(settlement), amount);
        settlement.escrow(jobId, amount, uint64(block.timestamp + 1 hours));
        vm.stopPrank();

        ISettlement.ProofBundle memory p = _signProof(jobId, keccak256("in"), keccak256("out"), bytes("m"), nodeKey);
        settlement.settle(p, node);
        assertEq(usdc.balanceOf(node) + settlement.accruedFees(), amount);
    }

    // The M9 redundant-execution flow has its own suites: Redundant.t.sol (state machine +
    // conservation) and PoCSybilSlash.t.sol (the five Sybil/copy/bond/input attacks).

    // ============================ admin surface (M8 / D5) ============================

    function test_setTreasury_updates() public {
        settlement.setTreasury(address(0xCAFE));
        assertEq(settlement.treasury(), address(0xCAFE));
    }

    function test_setTreasury_rejectsZeroAndNonOwner() public {
        vm.expectRevert(bytes("TREASURY_ZERO"));
        settlement.setTreasury(address(0));

        vm.prank(buyer);
        vm.expectRevert(bytes("NOT_OWNER"));
        settlement.setTreasury(address(0xCAFE));
    }

    function test_setFeeBps_updatesAndBounds() public {
        settlement.setFeeBps(100);
        assertEq(settlement.feeBps(), 100);

        vm.expectRevert(bytes("FEE_TOO_HIGH"));
        settlement.setFeeBps(10_001);

        vm.prank(buyer);
        vm.expectRevert(bytes("NOT_OWNER"));
        settlement.setFeeBps(10);
    }

    function test_setFeeBps_appliesLiveAtSettle() public {
        bytes32 jobId = keccak256("fee-change");
        _escrow(jobId, AMOUNT);
        settlement.setFeeBps(1000); // 10%
        ISettlement.ProofBundle memory p = _signProof(jobId, keccak256("in"), keccak256("out"), bytes("m"), nodeKey);
        settlement.settle(p, node);
        uint256 fee = (AMOUNT * 1000) / 10_000;
        assertEq(settlement.accruedFees(), fee);
        assertEq(usdc.balanceOf(node), AMOUNT - fee);
    }

    function test_ownership_twoStepTransfer() public {
        address newOwner = address(0xD00D);
        settlement.transferOwnership(newOwner);
        assertEq(settlement.pendingOwner(), newOwner);
        assertEq(settlement.owner(), address(this)); // not transferred until accepted

        vm.prank(buyer);
        vm.expectRevert(bytes("NOT_PENDING_OWNER"));
        settlement.acceptOwnership();

        vm.prank(newOwner);
        settlement.acceptOwnership();
        assertEq(settlement.owner(), newOwner);
        assertEq(settlement.pendingOwner(), address(0));
    }

    function test_pause_blocksEscrowAndSettle() public {
        settlement.pause();
        assertTrue(settlement.paused());

        vm.startPrank(buyer);
        usdc.approve(address(settlement), AMOUNT);
        vm.expectRevert(bytes("PAUSED"));
        settlement.escrow(keccak256("p1"), AMOUNT, uint64(block.timestamp + 1 hours));
        vm.stopPrank();
    }

    function test_pause_neverTrapsFunds_refundWorks() public {
        bytes32 jobId = keccak256("p-refund");
        _escrow(jobId, AMOUNT);
        settlement.pause();
        vm.warp(block.timestamp + 2 hours); // past deadline
        settlement.refund(jobId); // refund is NOT pausable — funds can always exit
        assertEq(uint8(settlement.jobStatus(jobId)), uint8(ISettlement.JobStatus.Refunded));
    }

    function test_unpause_resumes() public {
        settlement.pause();
        settlement.unpause();
        assertFalse(settlement.paused());
        bytes32 jobId = keccak256("resumed");
        _escrow(jobId, AMOUNT);
        assertEq(uint8(settlement.jobStatus(jobId)), uint8(ISettlement.JobStatus.Escrowed));
    }

    function test_pause_onlyOwner() public {
        vm.prank(buyer);
        vm.expectRevert(bytes("NOT_OWNER"));
        settlement.pause();
    }
}
