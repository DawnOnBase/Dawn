// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISettlement} from "./interfaces/ISettlement.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IOperatorStaking} from "./interfaces/IOperatorStaking.sol";

/// @title Dawn Settlement
/// @author Dawn
/// @notice Escrows a job's USDC, verifies the node's EIP-712 proof of execution,
///         releases payout, and collects the protocol fee. Supports single-node
///         settlement and redundant-execution consensus with bonded nodes.
/// @dev Proof signatures are EIP-712 typed data (domain-separated by chainId + this
///      contract's address) so a node attestation can't be replayed elsewhere.
///      The Phase-3 fee split (burn/treasury/stakers) is still gated .
contract Settlement is ISettlement {
    // --- config ---
    IERC20 public immutable usdc;
    /// @notice Redundant-execution flow gate. Disabled at deploy until the consensus design is
    ///         redesigned for Sybil resistance (see SECURITY.md). The single-node flow is unaffected.
    bool public immutable redundantEnabled;
    address public treasury;
    uint16 public feeBps; // 50 = 0.50%
    uint16 public constant MAX_BPS = 10_000;
    /// @notice Upper bound on how far ahead a deadline may be set, so a max-uint64 deadline
    ///         can't make refund / bond-return mathematically unreachable.
    uint64 public constant MAX_DEADLINE = 90 days;

    /// @notice Fees + slashed bonds owed to the treasury, paid out via withdrawFees() (pull-based,
    ///         so a reverting/blacklisted treasury can't brick settlement for everyone else).
    uint256 public accruedFees;

    /// @notice Pull-based redundant-flow winner rewards (M9). Credited on claim(), swept by the
    ///         winner via withdrawReward(), so a blacklisted/reverting payout address can never
    ///         block a claim or strand a bond.
    mapping(address => uint256) public withdrawableReward;

    // --- M9 redundant-flow config (the redundant-execution design) ---
    // All inert unless redundantEnabled && orchestrator != 0 && staking != 0. The single-node
    // flow never reads any of these. Set post-construction by the owner so the single-node
    // deployment keeps its original 4-arg constructor (parity).

    /// @notice The orchestrator key that EIP-712-signs committee Assignments. Authorization,
    ///         not economics, is the primary Sybil cut (M9 doc). Owner-rotatable.
    address public orchestrator;
    /// @notice Isolated stake/bond vault. Bonds are locked from operator stake here, never held by
    ///         this contract — a staking bug can't reach escrowed buyer USDC (M9 doc).
    IOperatorStaking public staking;
    /// @notice Minimum per-job bond (liveness/honesty deposit; the Sybil gate is authorization).
    uint256 public constant MIN_BOND = 1e6; // 1.0 USDC
    /// @notice Window after a super-plurality is reached during which the buyer can challenge
    ///         (void) the result before any payout/slash — protects an honest node from A2.
    uint64 public constant CHALLENGE_WINDOW = 1 hours;
    /// @notice Flat fee the buyer forfeits to challenge (void) a consensus, so griefing the committee
    ///         out of its reward is not free. v1 is non-refundable (no on-chain adjudication yet);
    ///         adjudicated refund-on-valid-challenge is Phase 2 (M9 doc).
    uint256 public constant CHALLENGE_BOND = 1e6; // 1.0 USDC
    /// @notice Cold-start guardrail: max escrow for a redundant job (0 = no cap). Owner-settable.
    uint256 public maxRedundantAmount;

    // --- EIP-712 ---
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _PROOF_TYPEHASH =
        keccak256("Proof(bytes32 jobId,bytes32 inputHash,bytes32 outputHash,bytes32 metadataHash)");
    // M9: the orchestrator-signed committee authorization. Same "Dawn Settlement" v1 domain as Proof;
    // signed by the orchestrator key, not a node. (the redundant-execution design)
    // On-chain Assignment-replay protection derives from jobId-uniqueness (_openEscrow's JOB_EXISTS:
    // a jobId slot is never reset), NOT from `nonce` — which is signed metadata binding the
    // orchestrator's intent for off-chain bookkeeping. A re-run after a void uses a FRESH jobId.
    bytes32 private constant _ASSIGNMENT_TYPEHASH = keccak256(
        "Assignment(bytes32 jobId,bytes32 inputHash,bytes32 operatorSetRoot,uint16 redundancy,uint64 deadline,uint256 amount,uint256 bond,uint256 nonce)"
    );
    bytes32 private constant _HASHED_NAME = keccak256("Dawn Settlement");
    bytes32 private constant _HASHED_VERSION = keccak256("1");
    // secp256k1 half-order; reject high-s sigs (EIP-2 malleability guard).
    uint256 private constant _HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;

    // --- state ---
    struct Job {
        address buyer;
        uint256 amount;
        uint64 deadline;
        JobStatus status;
        uint16 redundancy; // 1 = single-node (settle); >=2 = redundant (submitProof)
        uint256 bond; // required per-node bond (redundant only)
        bytes32 winningHash; // set on consensus
        uint256 rewardPerWinner; // set on consensus
        // --- M9 (zero for single-node jobs) ---
        bytes32 inputHash; // orchestrator-pinned keccak256(canonical Job Package); bound at submit
        bytes32 operatorSetRoot; // Merkle root over the authorized operator addresses
        uint16 quorum; // super-plurality threshold = ceil(redundancy * 2/3); frozen at escrow
        uint64 consensusAt; // timestamp the super-plurality was reached (starts the challenge window)
        bool consensusFinalized; // set on the first post-window claim; realizes the fee exactly once
    }

    struct Submission {
        bytes32 outputHash;
        uint256 bond;
        bool submitted;
        bool claimed;
    }

    mapping(bytes32 => Job) public jobs;
    mapping(bytes32 => mapping(address => Submission)) public submissions; // jobId => operator => submission
    mapping(bytes32 => mapping(bytes32 => uint16)) public matchCount; // jobId => outputHash => count

    // --- reentrancy guard ---
    uint256 private _lock = 1;

    modifier nonReentrant() {
        require(_lock == 1, "REENTRANCY");
        _lock = 2;
        _;
        _lock = 1;
    }

    // --- ownership (two-step) + emergency pause (M8 admin surface, D5) ---
    address public owner;
    address public pendingOwner;
    /// @notice When true, new escrows + settlement are paused. Money-OUT paths
    ///         (refund, claim, withdrawFees) are NEVER pausable so funds can't be trapped.
    bool public paused;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event FeeBpsUpdated(uint16 previousFeeBps, uint16 newFeeBps);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event OrchestratorUpdated(address indexed previousOrchestrator, address indexed newOrchestrator);
    event StakingSet(address indexed staking);
    event MaxRedundantAmountUpdated(uint256 previousMax, uint256 newMax);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "PAUSED");
        _;
    }

    constructor(IERC20 _usdc, address _treasury, uint16 _feeBps, bool _redundantEnabled) {
        require(address(_usdc) != address(0), "USDC_ZERO");
        require(_treasury != address(0), "TREASURY_ZERO");
        require(_feeBps <= MAX_BPS, "FEE_TOO_HIGH");
        usdc = _usdc;
        treasury = _treasury;
        feeBps = _feeBps;
        redundantEnabled = _redundantEnabled;
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ============================ single-node flow ============================

    /// @inheritdoc ISettlement
    function escrow(bytes32 jobId, uint256 amount, uint64 deadline) external nonReentrant whenNotPaused {
        _openEscrow(jobId, amount, deadline, 1, 0, bytes32(0), bytes32(0), 0);
        _safeTransferFrom(msg.sender, address(this), amount, "TRANSFER_FROM_FAIL");
        emit JobEscrowed(jobId, msg.sender, amount, deadline);
    }

    /// @inheritdoc ISettlement
    function settle(ProofBundle calldata proof, address operator) external nonReentrant whenNotPaused {
        Job storage job = jobs[proof.jobId];
        require(job.status == JobStatus.Escrowed, "NOT_ESCROWED");
        require(job.redundancy == 1, "USE_SUBMIT_PROOF");
        // Mirror submitProof's deadline gate so settle (<=deadline) and refund (>deadline) are
        // mutually exclusive — no settle-vs-refund race, buyer's deadline guarantee holds.
        require(block.timestamp <= job.deadline, "EXPIRED");
        require(operator != address(0), "OPERATOR_ZERO");
        require(_recoverProofSigner(proof) == operator, "BAD_PROOF");

        uint256 amount = job.amount;
        uint256 fee = (amount * feeBps) / MAX_BPS;
        uint256 payout = amount - fee;
        job.status = JobStatus.Settled;

        _safeTransfer(operator, payout, "PAYOUT_FAIL");
        if (fee > 0) {
            accruedFees += fee; // pull-based; swept by withdrawFees()
            emit FeeCollected(proof.jobId, fee);
        }
        emit JobSettled(proof.jobId, operator, payout, fee);
    }

    // ========================= redundant-execution flow =========================

    /// @inheritdoc ISettlement
    /// @dev Buyer escrows; the orchestrator authorizes the committee out-of-band via an
    ///      EIP-712 Assignment signature that pins `inputHash` + `operatorSetRoot`. Authorization —
    ///      not a keypair or a bond — is the Sybil cut: one actor can occupy at most one committee
    ///      seat (M9 doc,). Gated off until redundantEnabled + the M9 wiring is set + audited.
    function escrowRedundant(RedundantEscrow calldata e, bytes calldata orchestratorSig)
        external
        nonReentrant
        whenNotPaused
    {
        require(redundantEnabled, "REDUNDANT_DISABLED");
        require(orchestrator != address(0) && address(staking) != address(0), "M9_NOT_CONFIGURED");
        require(e.redundancy >= 2, "USE_ESCROW");
        require(e.bond >= MIN_BOND, "BOND_TOO_LOW"); // kills A4 (zero-bond)
        require(e.inputHash != bytes32(0) && e.operatorSetRoot != bytes32(0), "BAD_ASSIGNMENT_ARGS");
        if (maxRedundantAmount != 0) require(e.amount <= maxRedundantAmount, "AMOUNT_CAPPED");

        // Verify the orchestrator authorized THIS committee for THIS input (kills A1/A3/A5 at the root).
        _verifyAssignment(e, orchestratorSig);

        _openEscrow(
            e.jobId, e.amount, e.deadline, e.redundancy, e.bond, e.inputHash, e.operatorSetRoot, _quorum(e.redundancy)
        );
        _safeTransferFrom(msg.sender, address(this), e.amount, "TRANSFER_FROM_FAIL");
        emit JobEscrowed(e.jobId, msg.sender, e.amount, e.deadline);
        emit RedundantJobAuthorized(e.jobId, e.operatorSetRoot, e.redundancy, e.bond, e.nonce);
    }

    /// @inheritdoc ISettlement
    /// @dev The submitter must be an authorized committee member (`merkleProof` against the pinned
    ///      `operatorSetRoot`) and the proof's `inputHash` must equal the job's. A super-plurality
    ///      (`quorum` = ceil(redundancy*2/3)) of matching `outputHash`es freezes consensus to
    ///      PendingConsensus — NOT instant payout: nothing pays or slashes until the challenge window.
    function submitProof(ProofBundle calldata proof, address operator, bytes32[] calldata merkleProof)
        external
        nonReentrant
        whenNotPaused
    {
        Job storage job = jobs[proof.jobId];
        require(job.status == JobStatus.Escrowed, "NOT_ESCROWED"); // frozen at consensus → exactly `quorum` winners
        require(job.redundancy >= 2, "NOT_REDUNDANT");
        require(block.timestamp <= job.deadline, "EXPIRED");
        require(operator != address(0), "OPERATOR_ZERO");
        require(_recoverProofSigner(proof) == operator, "BAD_PROOF");
        require(proof.inputHash == job.inputHash, "INPUT_MISMATCH"); // kills A5 (wrong-input)
        require(_verifyMembership(job.operatorSetRoot, operator, merkleProof), "NOT_AUTHORIZED"); // kills A1/A3

        Submission storage sub = submissions[proof.jobId][operator];
        require(!sub.submitted, "ALREADY_SUBMITTED");

        // Lock the bond from the operator's stake (capital lives in the isolated vault, not here).
        staking.lock(operator, job.bond);
        sub.submitted = true;
        sub.outputHash = proof.outputHash;
        sub.bond = job.bond;

        uint16 count = matchCount[proof.jobId][proof.outputHash] + 1;
        matchCount[proof.jobId][proof.outputHash] = count;
        emit ProofSubmitted(proof.jobId, operator, proof.outputHash);

        if (count >= job.quorum) {
            // Super-plurality reached → freeze. Exactly `quorum` matching submissions exist (we stop
            // accepting at Escrowed→PendingConsensus), so the winner set is exactly `quorum` operators.
            uint256 fee = (job.amount * feeBps) / MAX_BPS;
            uint256 perWinner = (job.amount - fee) / job.quorum;

            job.winningHash = proof.outputHash;
            job.rewardPerWinner = perWinner;
            job.status = JobStatus.PendingConsensus;
            job.consensusAt = uint64(block.timestamp);

            // No funds move yet. The fee is NOT credited here: a challenge can still void this and
            // refund the FULL escrow. The treasury cut (amount - perWinner*quorum = fee + dust) is
            // realized only on the first post-window claim (claim()), so escrow stays solvent.
            emit JobConsensus(proof.jobId, proof.outputHash, job.quorum, perWinner, job.amount - perWinner * job.quorum);
        }
    }

    /// @inheritdoc ISettlement
    /// @dev v1: buyer-only, and the buyer forfeits a flat CHALLENGE_BOND so voiding an honest
    ///      committee's reward is not free (anti-grief). A wrong consensus is caught by the buyer /
    ///      their watchtower (M9 doc) before the window closes; voiding protects the honest
    ///      dissenter from being slashed (A2). Member-initiated challenges + adjudicated
    ///      refund-on-valid-challenge are Phase 2.
    function challenge(bytes32 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.PendingConsensus, "NOT_PENDING");
        require(block.timestamp <= job.consensusAt + CHALLENGE_WINDOW, "WINDOW_CLOSED");
        require(msg.sender == job.buyer, "NOT_CHALLENGER");
        job.status = JobStatus.Challenged;
        // Effects before interaction: forfeit the (non-refundable, v1) challenge fee to the treasury.
        accruedFees += CHALLENGE_BOND;
        _safeTransferFrom(msg.sender, address(this), CHALLENGE_BOND, "CHALLENGE_BOND_FAIL");
        emit ConsensusChallenged(jobId, msg.sender);
    }

    /// @inheritdoc ISettlement
    /// @dev Permissionless (anyone may finalize any submitter, so a keeper can realize slashes).
    ///      Reward comes from escrow; bonds are released/slashed in the isolated staking vault.
    function claim(bytes32 jobId, address operator) external nonReentrant {
        Job storage job = jobs[jobId];
        require(job.redundancy >= 2, "NOT_REDUNDANT");

        Submission storage sub = submissions[jobId][operator];
        require(sub.submitted, "NO_SUBMISSION");
        require(!sub.claimed, "ALREADY_CLAIMED");

        if (job.status == JobStatus.PendingConsensus) {
            // No payout or slash until the challenge window elapses (protects honest nodes, A2).
            require(block.timestamp > job.consensusAt + CHALLENGE_WINDOW, "CHALLENGE_OPEN");
            // The window closed unchallenged → consensus is now final. Realize the treasury cut
            // (fee + dust = amount - perWinner*quorum) exactly once, on the first finalizing claim.
            if (!job.consensusFinalized) {
                job.consensusFinalized = true;
                uint256 treasuryDue = job.amount - job.rewardPerWinner * job.quorum;
                if (treasuryDue > 0) {
                    accruedFees += treasuryDue; // pull-based; swept by withdrawFees()
                    emit FeeCollected(jobId, treasuryDue);
                }
            }
            sub.claimed = true;
            if (sub.outputHash == job.winningHash) {
                uint256 reward = job.rewardPerWinner;
                // Pull-based payout (like accruedFees): credit the reward + release the bond as
                // bookkeeping, so a winner with a blacklisted/reverting payout address can NEVER
                // block its own claim or strand its bond. The winner sweeps via withdrawReward().
                staking.release(operator, sub.bond); // bond back to free stake
                withdrawableReward[operator] += reward; // reward stays in escrow until swept
                emit RewardClaimed(jobId, operator, reward, sub.bond);
            } else {
                // Wrong reveal after an unchallenged window: slash bond -> accruedFees (pull-based).
                if (sub.bond > 0) {
                    // Effects before interaction (CEI): credit the treasury, then pull the slash.
                    accruedFees += sub.bond;
                    staking.slash(operator, sub.bond);
                }
                emit BondSlashed(jobId, operator, sub.bond);
            }
        } else if (job.status == JobStatus.Challenged || job.status == JobStatus.Refunded) {
            // Voided consensus or a refunded (no-consensus) job: bond returned, NEVER slashed.
            sub.claimed = true;
            staking.release(operator, sub.bond);
            emit BondReturned(jobId, operator, sub.bond);
        } else {
            // Still Escrowed and never reached consensus: bond reclaimable only after the deadline.
            require(block.timestamp > job.deadline, "NOT_FINAL");
            sub.claimed = true;
            staking.release(operator, sub.bond);
            emit BondReturned(jobId, operator, sub.bond);
        }
    }

    // ================================ shared ================================

    /// @inheritdoc ISettlement
    /// @dev For redundant jobs, escrow is returned to the buyer; submitters reclaim bonds via claim().
    ///      A Challenged job refunds immediately (consensus was voided); an Escrowed job refunds
    ///      only after the deadline. A PendingConsensus/Settled job is never refundable.
    function refund(bytes32 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status == JobStatus.Challenged) {
            // Voided consensus: buyer reclaims the full escrow now (bonds returned via claim()).
        } else {
            require(job.status == JobStatus.Escrowed, "NOT_ESCROWED");
            require(block.timestamp > job.deadline, "NOT_EXPIRED");
        }

        uint256 amount = job.amount;
        address buyer = job.buyer;
        job.status = JobStatus.Refunded;

        _safeTransfer(buyer, amount, "REFUND_FAIL");
        emit JobRefunded(jobId, buyer, amount);
    }

    /// @notice Sweep a redundant-flow winner's accumulated rewards. Pull-based (never pausable) so
    ///         a winner's payout can't be blocked by anyone else and a claim never reverts on payout.
    function withdrawReward() external nonReentrant {
        uint256 amount = withdrawableReward[msg.sender];
        withdrawableReward[msg.sender] = 0;
        if (amount > 0) {
            _safeTransfer(msg.sender, amount, "REWARD_WITHDRAW_FAIL");
            emit RewardWithdrawn(msg.sender, amount);
        }
    }

    /// @notice Sweep accrued fees + slashed bonds to the treasury. Pull-based so a reverting or
    ///         blacklisted treasury can never block settle / consensus / claim for other users.
    function withdrawFees() external nonReentrant {
        uint256 amount = accruedFees;
        accruedFees = 0;
        if (amount > 0) {
            _safeTransfer(treasury, amount, "WITHDRAW_FAIL");
            emit FeesWithdrawn(treasury, amount);
        }
    }

    /// @inheritdoc ISettlement
    function jobStatus(bytes32 jobId) external view returns (JobStatus) {
        return jobs[jobId].status;
    }

    // ================================ admin (M8 / D5) ================================
    // Intended owner: a multisig on mainnet. Two-step ownership so a typo'd handover
    // can't brick admin. setTreasury/setFeeBps make a lost/blacklisted treasury or a
    // needed fee change recoverable WITHOUT redeploying + re-wiring every off-chain client.

    /// @notice Begin transferring ownership; `newOwner` must call {acceptOwnership}.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Complete a pending ownership transfer (called by the new owner).
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "NOT_PENDING_OWNER");
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    /// @notice Repoint the protocol-fee treasury (e.g. rotate a compromised/blacklisted key).
    ///         Pull-based fees mean existing accruals are paid to the NEW treasury on next withdraw.
    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "TREASURY_ZERO");
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Update the protocol fee (bps). The fee is read LIVE at settle/consensus, so a
    ///         change applies to any not-yet-settled job. (Audit note: snapshotting feeBps at
    ///         escrow would be fairer to buyers; deferred — owner is a trusted multisig.)
    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        require(newFeeBps <= MAX_BPS, "FEE_TOO_HIGH");
        emit FeeBpsUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    /// @notice Emergency pause of new escrows + settlement. Money-OUT paths (refund, claim,
    ///         withdrawFees) stay open, so a pause can never trap funds already in the contract.
    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // --- M9 wiring (owner; the redundant flow stays inert until all three are set) ---

    /// @notice Set/rotate the orchestrator committee-signing key. Rotations only affect
    ///         NEW jobs — escrowed jobs already pinned their operatorSetRoot, so in-flight jobs are
    ///         unaffected. A trusted multisig owner; on mainnet the orchestrator is itself a
    ///         threshold/multisig signer (M9 doc).
    function setOrchestrator(address newOrchestrator) external onlyOwner {
        require(newOrchestrator != address(0), "ORCHESTRATOR_ZERO");
        emit OrchestratorUpdated(orchestrator, newOrchestrator);
        orchestrator = newOrchestrator;
    }

    /// @notice Link the isolated staking vault. One-shot (re-pointing would strand locked bonds).
    function setStaking(IOperatorStaking newStaking) external onlyOwner {
        require(address(staking) == address(0), "STAKING_SET");
        require(address(newStaking) != address(0), "STAKING_ZERO");
        staking = newStaking;
        emit StakingSet(address(newStaking));
    }

    /// @notice Cold-start guardrail: cap escrow per redundant job (0 = no cap; M9 doc).
    function setMaxRedundantAmount(uint256 newMax) external onlyOwner {
        emit MaxRedundantAmountUpdated(maxRedundantAmount, newMax);
        maxRedundantAmount = newMax;
    }

    // --- EIP-712 proof verification (public so off-chain signers can cross-check) ---

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    /// @notice The EIP-712 digest a node must sign to attest execution of `proof`.
    function proofDigest(ProofBundle calldata proof) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(_PROOF_TYPEHASH, proof.jobId, proof.inputHash, proof.outputHash, keccak256(proof.metadata))
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    // --- internal ---

    function _openEscrow(
        bytes32 jobId,
        uint256 amount,
        uint64 deadline,
        uint16 redundancy,
        uint256 bond,
        bytes32 inputHash,
        bytes32 operatorSetRoot,
        uint16 quorum
    ) private {
        require(jobs[jobId].status == JobStatus.None, "JOB_EXISTS");
        require(amount > 0, "AMOUNT_ZERO");
        require(deadline > block.timestamp, "DEADLINE_PAST");
        require(deadline <= block.timestamp + MAX_DEADLINE, "DEADLINE_TOO_FAR");
        jobs[jobId] = Job({
            buyer: msg.sender,
            amount: amount,
            deadline: deadline,
            status: JobStatus.Escrowed,
            redundancy: redundancy,
            bond: bond,
            winningHash: bytes32(0),
            rewardPerWinner: 0,
            inputHash: inputHash,
            operatorSetRoot: operatorSetRoot,
            quorum: quorum,
            consensusAt: 0,
            consensusFinalized: false
        });
    }

    // --- M9 helpers ---

    /// @notice Super-plurality threshold: ceil(redundancy * 2 / 3). For 2→2, 3→2, 4→3, 5→4.
    ///         Always 2 <= quorum <= redundancy for redundancy >= 2.
    function _quorum(uint16 redundancy) private pure returns (uint16) {
        return uint16((2 * uint256(redundancy) + 2) / 3);
    }

    /// @notice The EIP-712 digest the orchestrator signs to authorize a committee for a job.
    ///         Public so the off-chain orchestrator + indexer can cross-check byte-for-byte.
    function assignmentDigest(RedundantEscrow calldata e) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                _ASSIGNMENT_TYPEHASH,
                e.jobId,
                e.inputHash,
                e.operatorSetRoot,
                e.redundancy,
                e.deadline,
                e.amount,
                e.bond,
                e.nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Revert unless `orchestratorSig` is a valid orchestrator signature over the Assignment.
    function _verifyAssignment(RedundantEscrow calldata e, bytes calldata orchestratorSig) private view {
        require(_recover(assignmentDigest(e), orchestratorSig) == orchestrator, "BAD_ASSIGNMENT");
    }

    /// @notice OpenZeppelin-style sorted-pair Merkle membership. Leaf = keccak256(operator).
    function _verifyMembership(bytes32 root, address operator, bytes32[] calldata proof) private pure returns (bool) {
        bytes32 computed = keccak256(abi.encodePacked(operator));
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            computed =
                computed <= p ? keccak256(abi.encodePacked(computed, p)) : keccak256(abi.encodePacked(p, computed));
        }
        return computed == root;
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(_DOMAIN_TYPEHASH, _HASHED_NAME, _HASHED_VERSION, block.chainid, address(this)));
    }

    // --- SafeERC20 (M8): tolerate tokens that don't return a bool (e.g. USDT) and revert
    //     on a `false` return, instead of trusting a raw transfer's return value. ---

    function _safeTransfer(address to, uint256 amount, string memory err) private {
        _safeCall(abi.encodeWithSelector(IERC20.transfer.selector, to, amount), err);
    }

    function _safeTransferFrom(address from, address to, uint256 amount, string memory err) private {
        _safeCall(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount), err);
    }

    function _safeCall(bytes memory data, string memory err) private {
        (bool ok, bytes memory ret) = address(usdc).call(data);
        if (!ok) {
            // Bubble up the token's own revert reason (e.g. "BLACKLISTED") rather than masking it.
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        // A standard ERC-20 returns true; non-standard tokens (e.g. USDT) return nothing.
        require(ret.length == 0 || abi.decode(ret, (bool)), err);
    }

    function _recoverProofSigner(ProofBundle calldata proof) private view returns (address) {
        return _recover(proofDigest(proof), proof.nodeSignature);
    }

    /// @dev Guarded ecrecover: rejects malformed length, high-s malleability, and bad v.
    function _recover(bytes32 digest, bytes memory sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (uint256(s) > _HALF_N) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
