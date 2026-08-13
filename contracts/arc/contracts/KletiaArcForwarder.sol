// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

/**
 * @title KletiaArcForwarder
 * @dev Trusted forwarder for Kletia Omni-Engine on Arc Network.
 * Enables meta-transactions (sponsored gas) using EIP-712.
 */
contract KletiaArcForwarder is ERC2771Forwarder {
    constructor(string memory name) ERC2771Forwarder(name) {}
}
