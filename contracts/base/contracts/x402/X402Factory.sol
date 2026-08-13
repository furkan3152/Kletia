// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./X402Gateway.sol";

contract X402Factory {
    // Array to keep track of all deployed gateways
    X402Gateway[] public allGateways;

    // Mapping from owner address to their deployed gateways
    mapping(address => X402Gateway[]) public getGatewaysByOwner;

    event GatewayCreated(address indexed gatewayAddress, address indexed owner, address usdc, uint256 initialPrice);

    /**
     * @dev Deploys a new X402Gateway contract
     * @param _usdc The address of the USDC token (or any ERC20)
     * @param _initialPrice The initial price per API call (in token smallest units)
     * @return gateway The deployed X402Gateway contract address
     */
    function createGateway(address _usdc, uint256 _initialPrice) external returns (address gateway) {
        require(_usdc != address(0), "Invalid token address");

        // Deploy a new gateway with the caller as the initial owner
        X402Gateway newGateway = new X402Gateway(_usdc, _initialPrice, msg.sender);

        // Store the gateway
        allGateways.push(newGateway);
        getGatewaysByOwner[msg.sender].push(newGateway);

        emit GatewayCreated(address(newGateway), msg.sender, _usdc, _initialPrice);

        return address(newGateway);
    }

    /**
     * @dev Returns all gateways created by a specific owner
     */
    function getOwnerGateways(address owner) external view returns (X402Gateway[] memory) {
        return getGatewaysByOwner[owner];
    }

    /**
     * @dev Returns total number of gateways deployed
     */
    function allGatewaysLength() external view returns (uint256) {
        return allGateways.length;
    }
}
