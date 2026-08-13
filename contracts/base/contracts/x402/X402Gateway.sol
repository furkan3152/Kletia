// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Collects a fixed ERC-20 payment for an identified x402 resource.
contract X402Gateway is Ownable {
    IERC20 public immutable usdc;
    uint256 public pricePerCall;

    event PaymentReceived(
        address indexed payer,
        uint256 amount,
        string endpoint
    );
    event PriceUpdated(uint256 newPrice);

    constructor(
        address _usdc,
        uint256 _initialPrice,
        address _initialOwner
    ) Ownable(_initialOwner) {
        require(_usdc != address(0), "Invalid USDC address");
        usdc = IERC20(_usdc);
        pricePerCall = _initialPrice;
    }

    function setPrice(uint256 _newPrice) external onlyOwner {
        pricePerCall = _newPrice;
        emit PriceUpdated(_newPrice);
    }

    function pay(string calldata endpoint) external {
        require(pricePerCall > 0, "Price not set");
        require(
            usdc.transferFrom(msg.sender, address(this), pricePerCall),
            "Payment failed"
        );
        emit PaymentReceived(msg.sender, pricePerCall, endpoint);
    }

    function payExact(uint256 amount, string calldata endpoint) external {
        require(amount >= pricePerCall, "Insufficient amount");
        require(
            usdc.transferFrom(msg.sender, address(this), amount),
            "Payment failed"
        );
        emit PaymentReceived(msg.sender, amount, endpoint);
    }

    function withdraw(address to) external onlyOwner {
        uint256 balance = usdc.balanceOf(address(this));
        require(balance > 0, "No funds to withdraw");
        require(usdc.transfer(to, balance), "Withdrawal failed");
    }
}
