// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import {IKletiaSwapAdapterV2} from "../interfaces/IKletiaSwapAdapterV2.sol";

interface IUniswapV3FactoryLike {
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view returns (address pool);
}

interface IUniswapV3SwapRouter02Like {
        struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function factory() external view returns (address);

    function WETH9() external view returns (address);

    function exactInput(
        ExactInputParams calldata params
    ) external payable returns (uint256 amountOut);
}

contract UniswapV3SwapRouter02Adapter is IKletiaSwapAdapterV2 {
    bytes32 public constant ACTION_KIND =
        keccak256("KLETIA_SWAP_EXACT_INPUT_V2");
    bytes32 public constant ADAPTER_FORMAT_VERSION =
        keccak256("KLETIA_UNISWAP_V3_EXACT_INPUT_PACKED_PATH_V1");

    uint256 public constant MAX_HOPS = 4;

    uint256 private constant ADDRESS_SIZE = 20;
    uint256 private constant FEE_SIZE = 3;
    uint256 private constant NEXT_HOP_SIZE = ADDRESS_SIZE + FEE_SIZE;
    uint256 private constant MIN_PATH_LENGTH =
        ADDRESS_SIZE + NEXT_HOP_SIZE;
    uint256 private constant MAX_PATH_LENGTH =
        ADDRESS_SIZE + MAX_HOPS * NEXT_HOP_SIZE;
    uint24 private constant FEE_DENOMINATOR = 1_000_000;

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
    error RuntimeCodeChanged(
        address account,
        bytes32 expected,
        bytes32 actual
    );
    error RouterIntrospectionFailed(address router, bytes4 selector);
    error RouterFactoryMismatch(address expected, address actual);
    error RouterWrappedNativeMismatch(address expected, address actual);
    error InvalidSwapAmount();
    error InvalidSwapRecipient();
    error InvalidPathLength(uint256 length);
    error InvalidPathEndpoint(address expected, address actual);
    error InvalidPathToken(uint256 index);
    error RepeatedPathToken(
        address token,
        uint256 firstIndex,
        uint256 repeatedIndex
    );
    error InvalidPoolFee(uint256 hop, uint24 fee);
    error PoolUnavailable(
        address tokenA,
        address tokenB,
        uint24 fee,
        address pool
    );

    constructor(address router_, address factory_, address wrappedNative_) {
        if (
            router_ == address(0) ||
            factory_ == address(0) ||
            wrappedNative_ == address(0)
        ) revert InvalidAddress();

        _requireContract(router_);
        _requireContract(factory_);
        _requireContract(wrappedNative_);

        bytes32 routerHash = _codehash(router_);
        bytes32 factoryHash = _codehash(factory_);
        bytes32 wrappedNativeHash = _codehash(wrappedNative_);

        address routerFactory = _readRouterAddress(
            router_,
            IUniswapV3SwapRouter02Like.factory.selector
        );
        if (routerFactory != factory_) {
            revert RouterFactoryMismatch(factory_, routerFactory);
        }

        address routerWrappedNative = _readRouterAddress(
            router_,
            IUniswapV3SwapRouter02Like.WETH9.selector
        );
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
                ADAPTER_FORMAT_VERSION,
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
    )
        external
        view
        override
        returns (
            address callTarget,
            address allowanceSpender,
            bytes memory callData
        )
    {
        _requireCodehash(target, targetCodehash);
        _requireCodehash(factory, factoryCodehash);
        _requireCodehash(wrappedNative, wrappedNativeCodehash);

        if (swapCall.amountIn == 0 || swapCall.minAmountOut == 0) {
            revert InvalidSwapAmount();
        }
        if (swapCall.recipient == address(0)) {
            revert InvalidSwapRecipient();
        }

        _validatePath(
            adapterData,
            swapCall.tokenIn,
            swapCall.tokenOut
        );

        bytes memory path = adapterData;
        return (
            target,
            spender,
            abi.encodeCall(
                IUniswapV3SwapRouter02Like.exactInput,
                (
                    IUniswapV3SwapRouter02Like.ExactInputParams({
                        path: path,
                        recipient: swapCall.recipient,
                        amountIn: swapCall.amountIn,
                        amountOutMinimum: swapCall.minAmountOut
                    })
                )
            )
        );
    }

    function _validatePath(
        bytes calldata path,
        address expectedTokenIn,
        address expectedTokenOut
    ) private view {
        uint256 length = path.length;
        if (
            length < MIN_PATH_LENGTH ||
            length > MAX_PATH_LENGTH ||
            (length - ADDRESS_SIZE) % NEXT_HOP_SIZE != 0
        ) revert InvalidPathLength(length);

        uint256 hopCount = (length - ADDRESS_SIZE) / NEXT_HOP_SIZE;
        address firstToken = _readAddress(path, 0);
        address lastToken = _readAddress(path, length - ADDRESS_SIZE);

        if (firstToken != expectedTokenIn) {
            revert InvalidPathEndpoint(expectedTokenIn, firstToken);
        }
        if (lastToken != expectedTokenOut) {
            revert InvalidPathEndpoint(expectedTokenOut, lastToken);
        }

        address[5] memory seenTokens;
        if (firstToken == address(0)) revert InvalidPathToken(0);
        _requireContract(firstToken);
        seenTokens[0] = firstToken;

        address tokenIn = firstToken;
        uint256 cursor = ADDRESS_SIZE;
        for (uint256 hop; hop < hopCount; ++hop) {
            uint24 fee = _readUint24(path, cursor);
            if (fee == 0 || fee >= FEE_DENOMINATOR) {
                revert InvalidPoolFee(hop, fee);
            }

            uint256 tokenIndex = hop + 1;
            address tokenOut = _readAddress(path, cursor + FEE_SIZE);
            if (tokenOut == address(0)) {
                revert InvalidPathToken(tokenIndex);
            }
            _requireContract(tokenOut);

            for (uint256 seenIndex; seenIndex < tokenIndex; ++seenIndex) {
                if (seenTokens[seenIndex] == tokenOut) {
                    revert RepeatedPathToken(
                        tokenOut,
                        seenIndex,
                        tokenIndex
                    );
                }
            }
            seenTokens[tokenIndex] = tokenOut;

            address pool = IUniswapV3FactoryLike(factory).getPool(
                tokenIn,
                tokenOut,
                fee
            );
            if (pool == address(0) || pool.code.length == 0) {
                revert PoolUnavailable(
                    tokenIn,
                    tokenOut,
                    fee,
                    pool
                );
            }

            tokenIn = tokenOut;
            cursor += NEXT_HOP_SIZE;
        }
    }

    function _readRouterAddress(
        address router,
        bytes4 selector
    ) private view returns (address result) {
        (bool success, bytes memory returnData) = router.staticcall(
            abi.encodeWithSelector(selector)
        );
        if (!success || returnData.length != 32) {
            revert RouterIntrospectionFailed(router, selector);
        }

        uint256 raw;
        assembly ("memory-safe") {
            raw := mload(add(returnData, 0x20))
        }
        if (raw > type(uint160).max) {
            revert RouterIntrospectionFailed(router, selector);
        }
        result = address(uint160(raw));
    }

    function _readAddress(
        bytes calldata data,
        uint256 offset
    ) private pure returns (address result) {
        assembly ("memory-safe") {
            result := shr(96, calldataload(add(data.offset, offset)))
        }
    }

    function _readUint24(
        bytes calldata data,
        uint256 offset
    ) private pure returns (uint24 result) {
        assembly ("memory-safe") {
            result := shr(232, calldataload(add(data.offset, offset)))
        }
    }

    function _requireContract(address account) private view {
        if (account.code.length == 0) {
            revert ContractCodeRequired(account);
        }
    }

    function _requireCodehash(
        address account,
        bytes32 expected
    ) private view {
        _requireContract(account);
        bytes32 actual = _codehash(account);
        if (actual != expected) {
            revert RuntimeCodeChanged(account, expected, actual);
        }
    }

    function _codehash(
        address account
    ) private view returns (bytes32 result) {
        assembly ("memory-safe") {
            result := extcodehash(account)
        }
    }
}
