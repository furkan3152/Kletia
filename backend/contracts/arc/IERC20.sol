// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IERC20
 * @notice Minimal ERC-20 interface used by all Kletia ARC contracts.
 * @dev Intentionally kept lean — no optional `name()`/`symbol()`/`decimals()`
 *      so that the interface works with every compliant token (including USDC).
 */
interface IERC20 {
    /// @notice Returns the total token supply.
    function totalSupply() external view returns (uint256);

    /// @notice Returns the token balance of `account`.
    function balanceOf(address account) external view returns (uint256);

    /// @notice Moves `amount` tokens from caller to `to`.
    function transfer(address to, uint256 amount) external returns (bool);

    /// @notice Returns the remaining allowance `spender` can spend on behalf of `owner`.
    function allowance(address owner, address spender) external view returns (uint256);

    /// @notice Sets `amount` as the allowance of `spender` over caller's tokens.
    function approve(address spender, uint256 amount) external returns (bool);

    /// @notice Moves `amount` tokens from `from` to `to` using the allowance mechanism.
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    /// @dev Emitted when `value` tokens are moved from `from` to `to`.
    event Transfer(address indexed from, address indexed to, uint256 value);

    /// @dev Emitted when the allowance of a `spender` for an `owner` is set.
    event Approval(address indexed owner, address indexed spender, uint256 value);
}
