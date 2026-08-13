// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

interface IKletiaSwapAdapterV2 {
    struct SwapCall {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address recipient;
        uint48 deadline;
    }

    function actionKind() external pure returns (bytes32);

    function target() external view returns (address);

    function spender() external view returns (address);

    function configurationHash() external view returns (bytes32);

    function buildSwapCalldata(
        SwapCall calldata swapCall,
        bytes calldata adapterData
    ) external view returns (address callTarget, address allowanceSpender, bytes memory callData);
}
