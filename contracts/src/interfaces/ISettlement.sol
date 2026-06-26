// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISettlement
/// @notice On-chain settlement seam for Dawn. The event + proof shapes here are a
///         shared interface  mirrored by `packages/shared`. Changing
///         them requires sign-off from both the agent and the backend.
interface ISettlement {
    enum JobStatus {
        None,
        Escrowed,
        Settled,
        Refunded,
        // --- M9 redundant flow (appended; existing ordinals stable) ---
        PendingConsensus, // super-plurality reached; in the challenge window before payout
        Challenged // consensus voided; escrow refundable, bonds returned (no slash)
    }

    /// @dev Mirrors packages/shared `ProofBundle`. `nodeSignature` is an EIP-712 signature
    ///      by the executing node's wallet over
    ///      Proof(jobId, inputHash, outputHash, metadataHash) under the Settlement domain
    ///      (see Settlement.proofDigest). 65-byte packed (r, s, v), low-s only.
    struct ProofBundle {
        bytes32 jobId;
        bytes32 inputHash;
        bytes32 outputHash;
        bytes metadata; // abi-encoded: duration, resource usage, timestamps
        bytes nodeSignature;
    }

    /// @dev M9 redundant-escrow params, signed by the orchestrator as an EIP-712 `Assignment`
    ///      (the field order here matches the Assignment typehash in Settlement). Bundled as a
    ///      calldata struct so the buyer's escrow call stays within the EVM stack limit.
    struct RedundantEscrow {
        bytes32 jobId;
        uint256 amount;
        uint64 deadline;
        uint16 redundancy;
        uint256 bond;
        bytes32 inputHash;
        bytes32 operatorSetRoot;
        uint256 nonce;
    }

    // --- events ---
    event JobEscrowed(bytes32 indexed jobId, address indexed buyer, uint256 amount, uint64 deadline);
    event JobSettled(bytes32 indexed jobId, address indexed operator, uint256 payout, uint256 fee);
    event JobRefunded(bytes32 indexed jobId, address indexed buyer, uint256 amount);
    event FeeCollected(bytes32 indexed jobId, uint256 fee);
    event FeesWithdrawn(address indexed treasury, uint256 amount);

    // redundant-execution events
    event RedundantJobAuthorized(
        bytes32 indexed jobId, bytes32 operatorSetRoot, uint16 redundancy, uint256 bond, uint256 nonce
    );
    event ProofSubmitted(bytes32 indexed jobId, address indexed operator, bytes32 outputHash);
    event JobConsensus(
        bytes32 indexed jobId, bytes32 winningHash, uint16 winners, uint256 rewardPerWinner, uint256 fee
    );
    event ConsensusChallenged(bytes32 indexed jobId, address indexed challenger);
    event RewardClaimed(bytes32 indexed jobId, address indexed operator, uint256 reward, uint256 bondReturned);
    event RewardWithdrawn(address indexed operator, uint256 amount);
    event BondSlashed(bytes32 indexed jobId, address indexed operator, uint256 bond);
    event BondReturned(bytes32 indexed jobId, address indexed operator, uint256 bond);

    // --- single-node flow ---

    /// @notice Buyer locks `amount` USDC for a single-node `jobId` until `deadline`.
    function escrow(bytes32 jobId, uint256 amount, uint64 deadline) external;

    /// @notice Validate `proof` and release escrow to `operator` minus the protocol fee.
    /// @dev Single-node jobs only (redundancy == 1).
    function settle(ProofBundle calldata proof, address operator) external;

    // --- redundant-execution flow (M9: Sybil-resistant; see the redundant-execution design) ---

    /// @notice Buyer escrows a redundant job. The orchestrator (`the backend`) authorizes exactly the
    ///         `redundancy` operators committed by `operatorSetRoot` and pins `inputHash`, via an
    ///         EIP-712 `Assignment` signature. Each authorized node locks `bond` from its stake.
    function escrowRedundant(RedundantEscrow calldata e, bytes calldata orchestratorSig) external;

    /// @notice An authorized node posts its proof (bond locked from stake). The submitter must be
    ///         a leaf in `operatorSetRoot` (`merkleProof`) and `proof.inputHash` must match the job.
    ///         A super-plurality of matching `outputHash`es moves the job to PendingConsensus.
    function submitProof(ProofBundle calldata proof, address operator, bytes32[] calldata merkleProof) external;

    /// @notice Void a PendingConsensus result within the challenge window (buyer only in v1),
    ///         protecting an honest node from a wrong-consensus slash. Routes to refund + bonds back.
    function challenge(bytes32 jobId) external;

    /// @notice Resolve one submitter's outcome (callable by anyone, after the challenge window).
    ///         Winner -> reward + bond released; losing hash -> bond slashed; voided/expired -> bond returned.
    function claim(bytes32 jobId, address operator) external;

    // --- shared ---

    /// @notice Return escrow to the buyer after the deadline passes unfulfilled.
    function refund(bytes32 jobId) external;

    /// @notice Sweep accrued protocol fees + slashed bonds to the treasury (pull-based).
    function withdrawFees() external;

    function jobStatus(bytes32 jobId) external view returns (JobStatus);
}
