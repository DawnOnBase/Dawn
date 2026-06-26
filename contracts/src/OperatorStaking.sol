// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOperatorStaking} from "./interfaces/IOperatorStaking.sol";
import {IERC20} from "./interfaces/IERC20.sol";

/// @title Dawn OperatorStaking
/// @author Dawn
/// @notice Isolated stake/bond vault for the M9 redundant-execution flow (M9 doc,).
///         Operators stake USDC; the Settlement contract (the sole `slasher`) locks a per-job
///         bond from that stake, then releases it (honest) or slashes it (wrong reveal).
/// @dev    Capital isolation: this vault NEVER holds escrowed buyer funds, and the owner can
///         NOT move operator money — only the immutable-once `slasher` (Settlement) can
///         lock/release/slash. Stays inert until the redundant flow is enabled + audited.
///
///         Conservation: this contract's USDC balance == Σ free + Σ locked at all times.
///         `stake` adds to free (USDC in); `lock`/`release` move between free↔locked (no
///         transfer); `slash` moves locked → OUT to the slasher; `withdraw` moves free → OUT
///         to the operator (after unbonding).
contract OperatorStaking is IOperatorStaking {
    IERC20 public immutable usdc;

    /// @notice Minimum total stake to participate — the per-identity Sybil cost (M9 doc).
    uint256 public immutable minStake;
    /// @notice Delay between requesting an unbond and being able to withdraw free stake.
    ///         Closes "stake → attack → flee": locked bonds can never be withdrawn, and free
    ///         stake only leaves after this period.
    uint64 public immutable unbondingPeriod;

    address public owner;
    /// @notice The only address allowed to lock/release/slash — the Settlement contract.
    ///         Set ONCE (deploy-order link), then frozen.
    address public slasher;

    mapping(address => uint256) public freeOf; // free: lockable + withdrawable-after-unbond
    mapping(address => uint256) public lockedOf; // locked as job bonds; never withdrawable
    mapping(address => uint64) public unbondingAt; // 0 = not unbonding; else withdraw-eligible time

    event SlasherSet(address indexed slasher);
    event Staked(address indexed operator, uint256 amount, uint256 newFree);
    event UnbondRequested(address indexed operator, uint64 withdrawableAt);
    event Withdrawn(address indexed operator, uint256 amount);
    event Locked(address indexed operator, uint256 amount);
    event Released(address indexed operator, uint256 amount);
    event Slashed(address indexed operator, uint256 amount, address indexed to);

    uint256 private _lock = 1;

    modifier nonReentrant() {
        require(_lock == 1, "REENTRANCY");
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlySlasher() {
        require(slasher != address(0) && msg.sender == slasher, "NOT_SLASHER");
        _;
    }

    constructor(IERC20 _usdc, uint256 _minStake, uint64 _unbondingPeriod) {
        require(address(_usdc) != address(0), "USDC_ZERO");
        require(_minStake > 0, "MIN_STAKE_ZERO");
        usdc = _usdc;
        minStake = _minStake;
        unbondingPeriod = _unbondingPeriod;
        owner = msg.sender;
    }

    /// @notice Link the Settlement contract as the sole slasher. One-shot (the deploy-order
    ///         link: Settlement takes this vault's address as immutable, so this is set after).
    function setSlasher(address newSlasher) external {
        require(msg.sender == owner, "NOT_OWNER");
        require(slasher == address(0), "SLASHER_SET");
        require(newSlasher != address(0), "SLASHER_ZERO");
        slasher = newSlasher;
        emit SlasherSet(newSlasher);
    }

    // --- operator stake lifecycle ---

    /// @notice Deposit USDC into free stake. Re-staking cancels a pending unbond. Total stake
    ///         must reach `minStake` (the Sybil floor).
    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "AMOUNT_ZERO");
        _safeTransferFrom(msg.sender, address(this), amount, "STAKE_FAIL");
        uint256 newFree = freeOf[msg.sender] + amount;
        freeOf[msg.sender] = newFree;
        unbondingAt[msg.sender] = 0; // a fresh deposit re-commits; restart any unbond explicitly
        require(newFree + lockedOf[msg.sender] >= minStake, "BELOW_MIN_STAKE");
        emit Staked(msg.sender, amount, newFree);
    }

    /// @notice Begin unbonding; free stake becomes withdrawable after `unbondingPeriod`.
    ///         Locked bonds are unaffected (they remain slashable through their challenge window).
    function requestUnbond() external {
        uint64 at = uint64(block.timestamp) + unbondingPeriod;
        unbondingAt[msg.sender] = at;
        emit UnbondRequested(msg.sender, at);
    }

    /// @notice Withdraw ALL free stake after the unbonding period. Money-OUT path. Locked
    ///         bonds cannot be withdrawn — they exit only via release (back to free) or slash.
    function withdraw() external nonReentrant {
        uint64 at = unbondingAt[msg.sender];
        require(at != 0 && block.timestamp >= at, "UNBONDING");
        uint256 amount = freeOf[msg.sender];
        require(amount > 0, "NOTHING_FREE");
        freeOf[msg.sender] = 0;
        unbondingAt[msg.sender] = 0;
        _safeTransfer(msg.sender, amount, "WITHDRAW_FAIL");
        emit Withdrawn(msg.sender, amount);
    }

    // --- slasher (Settlement) hooks ---

    /// @inheritdoc IOperatorStaking
    function lock(address operator, uint256 amount) external onlySlasher {
        require(freeOf[operator] >= amount, "INSUFFICIENT_STAKE");
        unchecked {
            freeOf[operator] -= amount;
        }
        lockedOf[operator] += amount;
        emit Locked(operator, amount);
    }

    /// @inheritdoc IOperatorStaking
    function release(address operator, uint256 amount) external onlySlasher {
        require(lockedOf[operator] >= amount, "INSUFFICIENT_LOCKED");
        unchecked {
            lockedOf[operator] -= amount;
        }
        freeOf[operator] += amount;
        emit Released(operator, amount);
    }

    /// @inheritdoc IOperatorStaking
    function slash(address operator, uint256 amount) external onlySlasher nonReentrant {
        require(lockedOf[operator] >= amount, "INSUFFICIENT_LOCKED");
        unchecked {
            lockedOf[operator] -= amount;
        }
        if (amount > 0) {
            // To the slasher (Settlement) → credited to accruedFees → pull-based treasury.
            // Keeps the single treasury-payout path (withdrawFees) blacklist-safe.
            _safeTransfer(msg.sender, amount, "SLASH_FAIL");
        }
        emit Slashed(operator, amount, msg.sender);
    }

    // --- views ---

    function freeStake(address operator) external view returns (uint256) {
        return freeOf[operator];
    }

    function lockedStake(address operator) external view returns (uint256) {
        return lockedOf[operator];
    }

    // --- SafeERC20 (mirror Settlement): tolerate non-bool-returning tokens, bubble revert reason ---

    function _safeTransfer(address to, uint256 amount, string memory err) private {
        _safeCall(abi.encodeWithSelector(IERC20.transfer.selector, to, amount), err);
    }

    function _safeTransferFrom(address from, address to, uint256 amount, string memory err) private {
        _safeCall(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount), err);
    }

    function _safeCall(bytes memory data, string memory err) private {
        (bool ok, bytes memory ret) = address(usdc).call(data);
        if (!ok) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        require(ret.length == 0 || abi.decode(ret, (bool)), err);
    }
}
