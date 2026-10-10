// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ArcFinanceTokenMock is ERC20 {
    bool public rejectTransfers;
    uint256 public transferFeeBps;

    constructor() ERC20("Arc Finance Test Token", "TEST") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function setRejectTransfers(bool rejected) external {
        rejectTransfers = rejected;
    }

    function setTransferFee(uint256 feeBps) external {
        transferFeeBps = feeBps;
    }

    function transfer(address recipient, uint256 amount) public override returns (bool) {
        if (rejectTransfers) return false;
        return super.transfer(recipient, amount);
    }

    function transferFrom(address sender, address recipient, uint256 amount) public override returns (bool) {
        if (rejectTransfers) return false;
        return super.transferFrom(sender, recipient, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0) && transferFeeBps != 0) {
            uint256 fee = amount * transferFeeBps / 10_000;
            super._update(from, address(0), fee);
            amount -= fee;
        }
        super._update(from, to, amount);
    }
}

// Controlled cumulative-price source for lending transition and outage tests.
contract ArcPricePoolMock {
    uint256 public price = 1e18;
    uint256 public cumulative;
    uint256 public updatedAt = block.timestamp;
    bool public unavailable;
    bool public frozen;
    uint32 public frozenTimestamp;
    uint256 public frozenCumulative;

    function setPrice(uint256 newPrice) external {
        cumulative += price * (block.timestamp - updatedAt);
        updatedAt = block.timestamp;
        price = newPrice;
    }

    function setUnavailable(bool value) external {
        unavailable = value;
    }

    function setFrozen(bool value) external {
        frozen = value;
        frozenTimestamp = uint32(block.timestamp);
        frozenCumulative = cumulative + price * (block.timestamp - updatedAt);
    }

    function currentCumulativePrices() external view returns (uint256, uint256, uint32) {
        require(!unavailable, "oracle unavailable");
        if (frozen) return (frozenCumulative, 0, frozenTimestamp);
        return (cumulative + price * (block.timestamp - updatedAt), 0, uint32(block.timestamp));
    }
}
