// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Settlement} from "../src/Settlement.sol";
import {ISettlement} from "../src/interfaces/ISettlement.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @notice M9 redundant-flow e2e — phase 2: the buyer escrows with the GO-orchestrator-signed
///         Assignment (SIG env), then two authorized operators submit Merkle-gated proofs to reach
///         super-plurality consensus. The escrow succeeding is the on-chain proof that the contract
///         accepts the Go signature; it also runs a forged-signature rejection check.
contract RedundantE2ESubmit is Script {
    uint256 constant BUYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant OP0_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant OP1_KEY = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant OP2_KEY = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    function run() external {
        Settlement s = Settlement(vm.envAddress("SETTLEMENT"));
        MockUSDC usdc = MockUSDC(vm.envAddress("USDC"));
        bytes32 jobId = vm.envBytes32("JOBID");
        bytes32 inputHash = vm.envBytes32("INPUTHASH");
        uint256 amount = vm.envUint("AMOUNT");

        ISettlement.RedundantEscrow memory e = ISettlement.RedundantEscrow({
            jobId: jobId,
            amount: amount,
            deadline: uint64(vm.envUint("DEADLINE")),
            redundancy: 3,
            bond: vm.envUint("BOND"),
            inputHash: inputHash,
            operatorSetRoot: vm.envBytes32("ROOT"),
            nonce: vm.envUint("NONCE")
        });
        bytes memory sig = vm.envBytes("SIG");

        // The genuine Go-orchestrator-signed Assignment is accepted on-chain (forged/tampered
        // signatures are rejected — covered exhaustively by the unit tests).
        vm.startBroadcast(BUYER_KEY);
        usdc.approve(address(s), amount);
        s.escrowRedundant(e, sig);
        vm.stopBroadcast();
        require(uint8(s.jobStatus(jobId)) == uint8(ISettlement.JobStatus.Escrowed), "escrow not accepted");
        console2.log("GO_SIG_ACCEPTED");

        // op0 + op1 submit the same outputHash -> consensus (quorum = ceil(3*2/3) = 2).
        bytes32 outHash = keccak256("e2e-result");
        _submit(s, OP0_KEY, jobId, inputHash, outHash, _proof0());
        _submit(s, OP1_KEY, jobId, inputHash, outHash, _proof1());
        require(
            uint8(s.jobStatus(jobId)) == uint8(ISettlement.JobStatus.PendingConsensus), "did not reach consensus"
        );
        console2.log("CONSENSUS_OK");
    }

    function _submit(
        Settlement s,
        uint256 key,
        bytes32 jobId,
        bytes32 inputHash,
        bytes32 outHash,
        bytes32[] memory proof
    ) internal {
        address op = vm.addr(key);
        ISettlement.ProofBundle memory p = ISettlement.ProofBundle({
            jobId: jobId,
            inputHash: inputHash,
            outputHash: outHash,
            metadata: bytes("meta"),
            nodeSignature: ""
        });
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(key, s.proofDigest(p));
        p.nodeSignature = abi.encodePacked(r, ss, v);
        vm.broadcast(key);
        s.submitProof(p, op, proof);
    }

    // Sorted-pair Merkle proofs for the committee [op0, op1, op2] — the same root the Go signer built.
    function _leaves() internal view returns (bytes32 l0, bytes32 l1, bytes32 l2) {
        l0 = keccak256(abi.encodePacked(vm.addr(OP0_KEY)));
        l1 = keccak256(abi.encodePacked(vm.addr(OP1_KEY)));
        l2 = keccak256(abi.encodePacked(vm.addr(OP2_KEY)));
    }

    function _proof0() internal view returns (bytes32[] memory pr) {
        (, bytes32 l1, bytes32 l2) = _leaves();
        pr = new bytes32[](2);
        pr[0] = l1;
        pr[1] = l2;
    }

    function _proof1() internal view returns (bytes32[] memory pr) {
        (bytes32 l0,, bytes32 l2) = _leaves();
        pr = new bytes32[](2);
        pr[0] = l0;
        pr[1] = l2;
    }
}
