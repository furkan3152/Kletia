// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./KletiaToken.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract KletiaTokenFactory is Ownable {
    address public treasury;

    event TokenDeployed(address indexed tokenAddress, address indexed creator, string name, string symbol, uint256 totalSupply);

    constructor(address _treasury) Ownable(msg.sender) {
        treasury = _treasury;
    }

    function createToken(string memory name, string memory symbol, uint256 totalSupply) external returns (address) {
        KletiaToken newToken = new KletiaToken(name, symbol, totalSupply, msg.sender, treasury);
        
        emit TokenDeployed(address(newToken), msg.sender, name, symbol, totalSupply);
        return address(newToken);
    }
    
    function setTreasury(address _newTreasury) external onlyOwner {
        treasury = _newTreasury;
    }
}
