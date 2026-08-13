// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

interface IKletiaIntentTypesV2 {
    struct SwapIntent {
        address owner;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address recipient;
        address adapter;
        bytes32 adapterConfigHash;
        bytes32 adapterDataHash;
        uint256 nonce;
        uint48 issuedAt;
        uint48 validAfter;
        uint48 deadline;
        address executor;
        uint16 maxFeeBps;
    }

    struct BridgeIntent {
        address owner;
        address tokenIn;
        uint256 amountIn;
        uint256 destinationChainId;
        bytes32 destinationToken;
        bytes32 recipient;
        uint256 minAmountOut;
        address adapter;
        bytes32 adapterConfigHash;
        bytes32 adapterDataHash;
        uint256 nonce;
        uint48 issuedAt;
        uint48 validAfter;
        uint48 deadline;
        address executor;
        uint16 maxFeeBps;
    }
}
