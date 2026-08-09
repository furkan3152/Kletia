
pragma solidity ^0.8.20;

import "./X402Gateway.sol";

contract X402Factory {

    X402Gateway[] public allGateways;

    mapping(address => X402Gateway[]) public getGatewaysByOwner;

    event GatewayCreated(address indexed gatewayAddress, address indexed owner, address usdc, uint256 initialPrice);

        function createGateway(address _usdc, uint256 _initialPrice) external returns (address gateway) {
        require(_usdc != address(0), "Invalid token address");

        X402Gateway newGateway = new X402Gateway(_usdc, _initialPrice, msg.sender);

        allGateways.push(newGateway);
        getGatewaysByOwner[msg.sender].push(newGateway);

        emit GatewayCreated(address(newGateway), msg.sender, _usdc, _initialPrice);

        return address(newGateway);
    }

        function getOwnerGateways(address owner) external view returns (X402Gateway[] memory) {
        return getGatewaysByOwner[owner];
    }

        function allGatewaysLength() external view returns (uint256) {
        return allGateways.length;
    }
}
