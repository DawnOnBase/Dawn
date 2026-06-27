// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorStaking} from "../src/OperatorStaking.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Unit tests for the isolated stake/bond vault. This test contract acts as the `slasher`
///      (Settlement's role) so it can drive lock/release/slash directly.
contract OperatorStakingTest is Test {
    OperatorStaking staking;
    MockUSDC usdc;

    address op = address(0x0FF1);
    address treasury = address(0xBEEF);

    uint256 constant MIN_STAKE = 10e6;
    uint64 constant UNBOND = 7 days;
    uint256 constant BOND = 10e6;

    function setUp() public {
        usdc = new MockUSDC();
        staking = new OperatorStaking(IERC20(address(usdc)), MIN_STAKE, UNBOND);
        staking.setSlasher(address(this)); // this test plays Settlement
        usdc.mint(op, 100e6);
    }

    function _stake(uint256 amount) internal {
        vm.startPrank(op);
        usdc.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    // ---- constructor + setSlasher ----

    function test_constructor_guards() public {
        vm.expectRevert(bytes("USDC_ZERO"));
        new OperatorStaking(IERC20(address(0)), MIN_STAKE, UNBOND);
        vm.expectRevert(bytes("MIN_STAKE_ZERO"));
        new OperatorStaking(IERC20(address(usdc)), 0, UNBOND);
    }

    function test_setSlasher_oneShotAndGuarded() public {
        OperatorStaking s = new OperatorStaking(IERC20(address(usdc)), MIN_STAKE, UNBOND);
        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("NOT_OWNER"));
        s.setSlasher(address(this));

        vm.expectRevert(bytes("SLASHER_ZERO"));
        s.setSlasher(address(0));

        s.setSlasher(address(this));
        assertEq(s.slasher(), address(this));
        vm.expectRevert(bytes("SLASHER_SET"));
        s.setSlasher(address(0x1234));
    }

    // ---- stake lifecycle ----

    function test_stake_increasesFreeAndEnforcesMin() public {
        vm.startPrank(op);
        usdc.approve(address(staking), 100e6);
        vm.expectRevert(bytes("AMOUNT_ZERO"));
        staking.stake(0);
        vm.expectRevert(bytes("BELOW_MIN_STAKE"));
        staking.stake(MIN_STAKE - 1);
        staking.stake(MIN_STAKE);
        vm.stopPrank();
        assertEq(staking.freeStake(op), MIN_STAKE);
        assertEq(usdc.balanceOf(address(staking)), MIN_STAKE);
    }

    function test_unbond_thenWithdrawAfterPeriod() public {
        _stake(MIN_STAKE);
        // can't withdraw before requesting / before the period
        vm.prank(op);
        vm.expectRevert(bytes("UNBONDING"));
        staking.withdraw();

        vm.prank(op);
        staking.requestUnbond();
        vm.prank(op);
        vm.expectRevert(bytes("UNBONDING")); // period not elapsed
        staking.withdraw();

        vm.warp(block.timestamp + UNBOND);
        vm.prank(op);
        staking.withdraw();
        assertEq(staking.freeStake(op), 0);
        assertEq(usdc.balanceOf(op), 100e6);
    }

    function test_restake_cancelsUnbond() public {
        _stake(MIN_STAKE);
        vm.prank(op);
        staking.requestUnbond();
        _stake(MIN_STAKE); // a fresh deposit clears the pending unbond
        vm.warp(block.timestamp + UNBOND);
        vm.prank(op);
        vm.expectRevert(bytes("UNBONDING")); // must request again
        staking.withdraw();
    }

    // ---- slasher hooks ----

    function test_lockReleaseSlash_onlySlasher() public {
        _stake(MIN_STAKE);
        vm.startPrank(address(0xBAD));
        vm.expectRevert(bytes("NOT_SLASHER"));
        staking.lock(op, BOND);
        vm.expectRevert(bytes("NOT_SLASHER"));
        staking.release(op, BOND);
        vm.expectRevert(bytes("NOT_SLASHER"));
        staking.slash(op, BOND);
        vm.stopPrank();
    }

    function test_lock_insufficientStakeReverts() public {
        _stake(MIN_STAKE);
        vm.expectRevert(bytes("INSUFFICIENT_STAKE"));
        staking.lock(op, MIN_STAKE + 1);
    }

    function test_lock_release_conserves() public {
        _stake(MIN_STAKE);
        staking.lock(op, BOND);
        assertEq(staking.freeStake(op), MIN_STAKE - BOND);
        assertEq(staking.lockedStake(op), BOND);
        // balance unchanged by lock (no transfer)
        assertEq(usdc.balanceOf(address(staking)), MIN_STAKE);

        staking.release(op, BOND);
        assertEq(staking.freeStake(op), MIN_STAKE);
        assertEq(staking.lockedStake(op), 0);
        assertEq(usdc.balanceOf(address(staking)), MIN_STAKE);
    }

    function test_slash_sendsToSlasherAndReducesLocked() public {
        _stake(MIN_STAKE);
        staking.lock(op, BOND);
        uint256 before = usdc.balanceOf(address(this));
        staking.slash(op, BOND);
        assertEq(staking.lockedStake(op), 0);
        assertEq(usdc.balanceOf(address(this)), before + BOND); // USDC went to the slasher
        assertEq(usdc.balanceOf(address(staking)), MIN_STAKE - BOND);
    }

    function test_lockedBond_notWithdrawable() public {
        _stake(MIN_STAKE);
        staking.lock(op, MIN_STAKE); // all stake locked
        vm.prank(op);
        staking.requestUnbond();
        vm.warp(block.timestamp + UNBOND);
        vm.prank(op);
        vm.expectRevert(bytes("NOTHING_FREE")); // locked bonds can't be withdrawn
        staking.withdraw();
    }

    function test_release_insufficientLockedReverts() public {
        _stake(MIN_STAKE);
        vm.expectRevert(bytes("INSUFFICIENT_LOCKED"));
        staking.release(op, BOND);
        vm.expectRevert(bytes("INSUFFICIENT_LOCKED"));
        staking.slash(op, BOND);
    }

    /// @dev Vault solvency: balance == Σ free + Σ locked, through lock + slash.
    function test_conservation_balanceEqualsFreePlusLocked() public {
        _stake(MIN_STAKE);
        staking.lock(op, BOND);
        staking.slash(op, BOND / 2);
        uint256 accounted = staking.freeStake(op) + staking.lockedStake(op);
        assertEq(usdc.balanceOf(address(staking)), accounted);
    }
}
