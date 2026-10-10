// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IKletiaSwapAdapterV2} from "../v2/interfaces/IKletiaSwapAdapterV2.sol";

// Local-test fixtures only. These contracts are never deployment candidates.
contract SettlementTokenMock is ERC20 {
    uint256 public transferFeeBps;
    bool public stickyAllowance;

    constructor(string memory name_) ERC20(name_, name_) {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function setTransferFee(uint256 feeBps) external {
        transferFeeBps = feeBps;
    }

    function setStickyAllowance(bool enabled) external {
        stickyAllowance = enabled;
    }

    function approve(address spender, uint256 amount) public override returns (bool) {
        return super.approve(spender, stickyAllowance && amount == 0 ? 1 : amount);
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

contract WrappedNativeMock is SettlementTokenMock {
    constructor() SettlementTokenMock("Wrapped Native") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "native transfer failed");
    }
}

contract SwapTargetMock {
    uint256 public spendBps = 10_000;
    uint256 public lastMinimum;

    function setSpendBps(uint256 value) external {
        spendBps = value;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 outputAmount
    ) external {
        lastMinimum = minAmountOut;
        SettlementTokenMock(tokenIn).transferFrom(msg.sender, address(this), amountIn * spendBps / 10_000);
        SettlementTokenMock(tokenOut).mint(recipient, outputAmount);
    }
}

contract SwapAdapterMock is IKletiaSwapAdapterV2 {
    address public immutable override target;
    address public immutable override spender;
    bytes32 public override configurationHash = keccak256("reviewed test configuration");
    address public returnedTarget;
    address public returnedSpender;

    constructor(address target_) {
        target = target_;
        spender = target_;
        returnedTarget = target_;
        returnedSpender = target_;
    }

    function actionKind() external pure returns (bytes32) {
        return keccak256("KLETIA_SWAP_EXACT_INPUT_V2");
    }

    function setConfigurationHash(bytes32 value) external {
        configurationHash = value;
    }

    function setReturnedAddresses(address target_, address spender_) external {
        returnedTarget = target_;
        returnedSpender = spender_;
    }

    function buildSwapCalldata(
        SwapCall calldata swapCall,
        bytes calldata adapterData
    ) external view returns (address, address, bytes memory) {
        uint256 outputAmount = abi.decode(adapterData, (uint256));
        return (returnedTarget, returnedSpender, abi.encodeCall(SwapTargetMock.swap, (
            swapCall.tokenIn,
            swapCall.tokenOut,
            swapCall.amountIn,
            swapCall.minAmountOut,
            swapCall.recipient,
            outputAmount
        )));
    }
}

contract V2FactoryMock {
    mapping(bytes32 => address) private pairs;

    function setPair(address a, address b, address pair) external {
        pairs[keccak256(abi.encode(a, b))] = pair;
        pairs[keccak256(abi.encode(b, a))] = pair;
    }

    function getPair(address a, address b) external view returns (address) {
        return pairs[keccak256(abi.encode(a, b))];
    }
}

contract V2RouterMock {
    address public immutable factory;
    address public immutable WETH;

    constructor(address factory_, address wrapped_) {
        factory = factory_;
        WETH = wrapped_;
    }
}

contract V3FactoryMock {
    mapping(bytes32 => address) private pools;

    function setPool(address a, address b, uint24 fee, address pool) external {
        pools[keccak256(abi.encode(a, b, fee))] = pool;
        pools[keccak256(abi.encode(b, a, fee))] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return pools[keccak256(abi.encode(a, b, fee))];
    }
}

contract V3RouterMock {
    address public immutable factory;
    address public immutable WETH9;

    constructor(address factory_, address wrapped_) {
        factory = factory_;
        WETH9 = wrapped_;
    }
}
