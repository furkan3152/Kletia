// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import {IKletiaSwapAdapterV2} from "../interfaces/IKletiaSwapAdapterV2.sol";

interface IUniswapV2FactoryLike {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IUniswapV2RouterLike {
    function factory() external view returns (address);

    function WETH() external view returns (address);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract UniswapV2CompatibleAdapter is IKletiaSwapAdapterV2 {
    bytes32 public constant ACTION_KIND = keccak256("KLETIA_SWAP_EXACT_INPUT_V2");
    uint256 public constant MAX_PATH_LENGTH = 5;

    address public immutable override target;
    address public immutable override spender;
    address public immutable factory;
    address public immutable wrappedNative;

    bytes32 public immutable targetCodehash;
    bytes32 public immutable factoryCodehash;
    bytes32 public immutable wrappedNativeCodehash;
    bytes32 public immutable override configurationHash;

    error InvalidAddress();
    error ContractCodeRequired(address account);
    error RuntimeCodeChanged(address account, bytes32 expected, bytes32 actual);
    error InvalidPathLength(uint256 length);
    error InvalidPathEndpoint(address expected, address actual);
    error InvalidPathToken(uint256 index);
    error PairUnavailable(address tokenA, address tokenB);
    error RouterFactoryMismatch(address expected, address actual);
    error RouterWrappedNativeMismatch(address expected, address actual);

    constructor(address router_, address factory_, address wrappedNative_) {
        if (
            router_ == address(0) ||
            factory_ == address(0) ||
            wrappedNative_ == address(0)
        ) revert InvalidAddress();

        if (router_.code.length == 0) revert ContractCodeRequired(router_);
        if (factory_.code.length == 0) revert ContractCodeRequired(factory_);
        if (wrappedNative_.code.length == 0) {
            revert ContractCodeRequired(wrappedNative_);
        }
        bytes32 routerHash = _codehash(router_);
        bytes32 factoryHash = _codehash(factory_);
        bytes32 wrappedNativeHash = _codehash(wrappedNative_);
        address routerFactory = IUniswapV2RouterLike(router_).factory();
        if (routerFactory != factory_) {
            revert RouterFactoryMismatch(factory_, routerFactory);
        }
        address routerWrappedNative = IUniswapV2RouterLike(router_).WETH();
        if (routerWrappedNative != wrappedNative_) {
            revert RouterWrappedNativeMismatch(
                wrappedNative_,
                routerWrappedNative
            );
        }

        target = router_;
        spender = router_;
        factory = factory_;
        wrappedNative = wrappedNative_;
        targetCodehash = routerHash;
        factoryCodehash = factoryHash;
        wrappedNativeCodehash = wrappedNativeHash;
        configurationHash = keccak256(
            abi.encode(
                ACTION_KIND,
                router_,
                router_,
                factory_,
                wrappedNative_,
                routerHash,
                factoryHash,
                wrappedNativeHash
            )
        );
    }

    function actionKind() external pure override returns (bytes32) {
        return ACTION_KIND;
    }

        function buildSwapCalldata(
        SwapCall calldata swapCall,
        bytes calldata adapterData
    ) external view override returns (address callTarget, address allowanceSpender, bytes memory callData) {
        _requireCodehash(target, targetCodehash);
        _requireCodehash(factory, factoryCodehash);
        _requireCodehash(wrappedNative, wrappedNativeCodehash);

        address[] memory path = abi.decode(adapterData, (address[]));
        uint256 length = path.length;
        if (length < 2 || length > MAX_PATH_LENGTH) revert InvalidPathLength(length);
        if (path[0] != swapCall.tokenIn) revert InvalidPathEndpoint(swapCall.tokenIn, path[0]);
        if (path[length - 1] != swapCall.tokenOut) {
            revert InvalidPathEndpoint(swapCall.tokenOut, path[length - 1]);
        }

        for (uint256 i; i < length; ++i) {
            if (path[i] == address(0)) revert InvalidPathToken(i);
            if (i != 0) {
                address pair = IUniswapV2FactoryLike(factory).getPair(path[i - 1], path[i]);
                if (pair == address(0) || pair.code.length == 0) {
                    revert PairUnavailable(path[i - 1], path[i]);
                }
            }
        }

        return (
            target,
            spender,
            abi.encodeCall(
                IUniswapV2RouterLike.swapExactTokensForTokens,
                (
                    swapCall.amountIn,
                    swapCall.minAmountOut,
                    path,
                    swapCall.recipient,
                    uint256(swapCall.deadline)
                )
            )
        );
    }

    function _requireCodehash(address account, bytes32 expected) private view {
        if (account.code.length == 0) revert ContractCodeRequired(account);
        bytes32 actual = _codehash(account);
        if (actual != expected) revert RuntimeCodeChanged(account, expected, actual);
    }

    function _codehash(address account) private view returns (bytes32 result) {
        assembly ("memory-safe") {
            result := extcodehash(account)
        }
    }
}
