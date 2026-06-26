// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Settlement} from "../src/Settlement.sol";
import {ISettlement} from "../src/interfaces/ISettlement.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Drives random sequences of Settlement calls over a fixed set of buyers/nodes/jobs.
///      All calls are wrapped in try/catch so wrong-state reverts don't abort the run — the
///      invariant must hold regardless of which calls succeed.
contract SettlementHandler is Test {
    Settlement public settlement;
    MockUSDC public usdc;

    address[] internal buyers;
    uint256[] internal nodeKeys;
    address[] internal nodes;
    bytes32[] internal jobIds;

    constructor(Settlement _s, MockUSDC _u, address[] memory _buyers, uint256[] memory _nodeKeys) {
        settlement = _s;
        usdc = _u;
        buyers = _buyers;
        nodeKeys = _nodeKeys;
        for (uint256 i; i < _nodeKeys.length; i++) {
            nodes.push(vm.addr(_nodeKeys[i]));
        }
        for (uint256 i; i < 8; i++) {
            jobIds.push(keccak256(abi.encode("job", i)));
        }
    }

    function _buyer(uint256 s) internal view returns (address) {
        return buyers[s % buyers.length];
    }

    function _job(uint256 s) internal view returns (bytes32) {
        return jobIds[s % jobIds.length];
    }

    function _nodeIdx(uint256 s) internal view returns (uint256) {
        return s % nodeKeys.length;
    }

    // A small output space so redundant nodes can actually reach consensus (or disagree).
    function _out(uint256 s) internal pure returns (bytes32) {
        return keccak256(abi.encode("out", s % 3));
    }

    function _sign(uint256 key, bytes32 jobId, bytes32 outHash)
        internal
        view
        returns (ISettlement.ProofBundle memory p)
    {
        p = ISettlement.ProofBundle({
            jobId: jobId, inputHash: keccak256("in"), outputHash: outHash, metadata: bytes("m"), nodeSignature: ""
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.proofDigest(p));
        p.nodeSignature = abi.encodePacked(r, s, v);
    }

    function escrow(uint256 bSeed, uint256 jSeed, uint256 amount) public {
        address b = _buyer(bSeed);
        uint256 bal = usdc.balanceOf(b);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.startPrank(b);
        usdc.approve(address(settlement), amount);
        try settlement.escrow(_job(jSeed), amount, uint64(block.timestamp + 1 days)) {} catch {}
        vm.stopPrank();
    }

    // Note: the redundant flow (escrowRedundant/submitProof/claim) is intentionally NOT driven by
    // this stateful invariant. With M9 it spans a SECOND contract (OperatorStaking holds bonds), so
    // a faithful conservation invariant must sum both contracts' balances — a documented auditor
    // follow-up (SECURITY.md). Here the Settlement deploys with redundantEnabled=false, so this
    // invariant guards the production single-node solvency path. The redundant flow's conservation
    // is covered by explicit assertions in Settlement.t.sol + PoCSybilSlash.t.sol.

    function settle(uint256 jSeed, uint256 nSeed, uint256 outSeed) public {
        uint256 idx = _nodeIdx(nSeed);
        ISettlement.ProofBundle memory p = _sign(nodeKeys[idx], _job(jSeed), _out(outSeed));
        try settlement.settle(p, nodes[idx]) {} catch {}
    }

    function refund(uint256 jSeed) public {
        try settlement.refund(_job(jSeed)) {} catch {}
    }

    function warp(uint256 dt) public {
        vm.warp(block.timestamp + bound(dt, 1 hours, 3 days));
    }

    function withdrawFees() public {
        try settlement.withdrawFees() {} catch {}
    }

    // exposed for the invariant's conservation sum
    function buyer(uint256 i) external view returns (address) {
        return buyers[i];
    }

    function node(uint256 i) external view returns (address) {
        return nodes[i];
    }

    function buyerCount() external view returns (uint256) {
        return buyers.length;
    }

    function nodeCount() external view returns (uint256) {
        return nodes.length;
    }
}

contract SettlementInvariantsTest is Test {
    Settlement settlement;
    MockUSDC usdc;
    SettlementHandler handler;

    address treasury = address(0xBEEF);
    uint256 constant TOTAL = 10_000e6;

    address[] buyers;
    uint256[] nodeKeys;
    address[] nodes;

    function setUp() public {
        usdc = new MockUSDC();
        // Single-node solvency invariant (redundant flow disabled — see the handler note).
        settlement = new Settlement(IERC20(address(usdc)), treasury, 50, false);

        buyers.push(address(0xB1));
        buyers.push(address(0xB2));
        nodeKeys.push(0xA11CE);
        nodeKeys.push(0xB0B0B0);
        nodeKeys.push(0xC0C0C0);
        for (uint256 i; i < nodeKeys.length; i++) {
            nodes.push(vm.addr(nodeKeys[i]));
        }

        // Fixed total distributed across buyers + nodes; nothing minted afterwards.
        usdc.mint(buyers[0], 4_000e6);
        usdc.mint(buyers[1], 3_000e6);
        usdc.mint(nodes[0], 1_000e6);
        usdc.mint(nodes[1], 1_000e6);
        usdc.mint(nodes[2], 1_000e6); // sum == TOTAL

        handler = new SettlementHandler(settlement, usdc, buyers, nodeKeys);
        targetContract(address(handler));
    }

    function _sumAll() internal view returns (uint256 sum) {
        sum += usdc.balanceOf(address(settlement));
        sum += usdc.balanceOf(treasury);
        for (uint256 i; i < buyers.length; i++) {
            sum += usdc.balanceOf(buyers[i]);
        }
        for (uint256 i; i < nodes.length; i++) {
            sum += usdc.balanceOf(nodes[i]);
        }
    }

    /// USDC only ever moves between {settlement, treasury, buyers, nodes} — never created or
    /// destroyed. This is the solvency backstop: escrow/payout/fee/bond/slash/refund all net to zero.
    function invariant_conservationOfFunds() public view {
        assertEq(_sumAll(), TOTAL);
    }

    /// The contract can never hold more than the whole supply (sanity; implied by conservation).
    function invariant_contractHoldingsBounded() public view {
        assertLe(usdc.balanceOf(address(settlement)), TOTAL);
    }
}
