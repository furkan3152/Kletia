// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract X402Gateway {
    using SafeERC20 for IERC20;

    address public owner;
    IERC20 public usdc;
    uint256 public pricePerCall;

    event PaymentReceived(address indexed payer, uint256 amount, string endpoint);
    event PriceUpdated(uint256 newPrice);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this");
        _;
    }

    constructor(address _usdc, uint256 _initialPrice, address _initialOwner) {
        usdc = IERC20(_usdc);
        pricePerCall = _initialPrice;
        owner = _initialOwner;
    }

    function setPrice(uint256 _newPrice) external onlyOwner {
        pricePerCall = _newPrice;
        emit PriceUpdated(_newPrice);
    }

    function withdraw(address to) external onlyOwner {
        uint256 balance = usdc.balanceOf(address(this));
        require(balance > 0, "No funds to withdraw");
        usdc.safeTransfer(to, balance);
    }

    // Explicit fallback for ExactEvmScheme if used
    function pay(string calldata endpoint) external {
        uint256 amount = pricePerCall;
        require(amount > 0, "Price not set");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit PaymentReceived(msg.sender, amount, endpoint);
    }
}

contract X402Factory {
    X402Gateway[] public allGateways;
    mapping(address => X402Gateway[]) public getOwnerGateways;

    event GatewayCreated(address indexed gatewayAddress, address indexed owner, address usdc, uint256 initialPrice);

    function createGateway(address _usdc, uint256 _initialPrice) external returns (address) {
        X402Gateway newGateway = new X402Gateway(_usdc, _initialPrice, msg.sender);
        
        allGateways.push(newGateway);
        getOwnerGateways[msg.sender].push(newGateway);

        emit GatewayCreated(address(newGateway), msg.sender, _usdc, _initialPrice);
        return address(newGateway);
    }

    function allGatewaysLength() external view returns (uint256) {
        return allGateways.length;
    }

    function getGatewaysByOwner(address _owner, uint256 _index) external view returns (X402Gateway) {
        return getOwnerGateways[_owner][_index];
    }
}
