// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IOperatorStaking
/// @notice The seam Settlement uses to lock / slash / release operator bonds for the M9
///         redundant-execution flow. Stake lives in a SEPARATE contract (capital isolation,
///         M9 doc) so a staking bug can never reach escrowed buyer USDC.
interface IOperatorStaking {
    /// @notice Move `amount` of `operator`'s free stake into the locked bucket (a job bond).
    /// @dev Only the slasher (the Settlement contract) may call.
    function lock(address operator, uint256 amount) external;

    /// @notice Release `amount` of `operator`'s locked bond back to free stake (no transfer out).
    function release(address operator, uint256 amount) external;

    /// @notice Slash `amount` of `operator`'s locked bond, transferring the USDC to the caller
    ///         (the Settlement contract, which credits it to accruedFees → pull-based treasury).
    function slash(address operator, uint256 amount) external;

    /// @notice `operator`'s free (lockable / withdrawable-after-unbond) stake.
    function freeStake(address operator) external view returns (uint256);

    /// @notice `operator`'s currently-locked bond total.
    function lockedStake(address operator) external view returns (uint256);
}
