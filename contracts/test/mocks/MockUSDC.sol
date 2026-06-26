// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal mock USDC for tests (not production). Reverts on underflow like a real
///      ERC-20 would on insufficient balance/allowance (checked arithmetic).
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    // Mimics Circle USDC on Base: transfers to a blacklisted address revert.
    mapping(address => bool) public blacklisted;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function setBlacklist(address account, bool isBlacklisted) external {
        blacklisted[account] = isBlacklisted;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(!blacklisted[to], "BLACKLISTED");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(!blacklisted[to], "BLACKLISTED");
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}
