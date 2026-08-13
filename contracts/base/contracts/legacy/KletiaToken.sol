// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract KletiaToken is ERC20, Ownable {
    constructor(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        address creator,
        address treasury
    ) ERC20(name, symbol) Ownable(creator) {
        uint256 treasuryAmount = (totalSupply * 10) / 100;
        uint256 creatorAmount = totalSupply - treasuryAmount;

        _mint(treasury, treasuryAmount);
        _mint(creator, creatorAmount);
    }
}
