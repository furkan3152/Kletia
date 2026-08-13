// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IKletiaIntentTypesV2} from "../interfaces/IKletiaIntentTypesV2.sol";
import {IKletiaSwapAdapterV2} from "../interfaces/IKletiaSwapAdapterV2.sol";
import {IWETH9} from "../interfaces/IWETH9.sol";

contract KletiaIntentRouterV2 is
    IKletiaIntentTypesV2,
    EIP712,
    Ownable2Step,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_FEE_BPS = 100;
    uint48 public constant MAX_INTENT_TTL = 1 hours;
    bytes32 public constant SWAP_ACTION_KIND = keccak256("KLETIA_SWAP_EXACT_INPUT_V2");
    bytes32 public constant ERC6492_MAGIC =
        0x6492649264926492649264926492649264926492649264926492649264926492;

    bytes32 public constant SWAP_INTENT_TYPEHASH =
        keccak256(
            "SwapIntent(address owner,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,address recipient,address adapter,bytes32 adapterConfigHash,bytes32 adapterDataHash,uint256 nonce,uint48 issuedAt,uint48 validAfter,uint48 deadline,address executor,uint16 maxFeeBps)"
        );

    bytes32 public constant BRIDGE_INTENT_TYPEHASH =
        keccak256(
            "BridgeIntent(address owner,address tokenIn,uint256 amountIn,uint256 destinationChainId,bytes32 destinationToken,bytes32 recipient,uint256 minAmountOut,address adapter,bytes32 adapterConfigHash,bytes32 adapterDataHash,uint256 nonce,uint48 issuedAt,uint48 validAfter,uint48 deadline,address executor,uint16 maxFeeBps)"
        );

    struct AdapterConfig {
        bool configured;
        bool enabled;
        address target;
        address spender;
        bytes32 adapterCodehash;
        bytes32 targetCodehash;
        bytes32 spenderCodehash;
        bytes32 adapterConfigurationHash;
        bytes32 configHash;
    }

    struct SettlementCache {
        address tokenIn;
        address tokenOut;
        uint256 inputBaseline;
        uint256 outputBaseline;
        uint256 grossAmountOut;
    }

    address public immutable wrappedNative;
    bytes32 public immutable wrappedNativeCodehash;

    address public guardian;
    address public treasury;
    address public pendingTreasury;
    uint16 public feeBps;
    bool public paused;

    mapping(address adapter => AdapterConfig config) public adapterConfig;
    mapping(address account => bool known) public isSystemAddress;
    mapping(address intentOwner => mapping(uint256 wordPosition => uint256 bitmap)) private _nonceBitmap;

    error InvalidAddress();
    error ContractCodeRequired(address account);
    error UnauthorizedGuardian(address caller);
    error UnauthorizedTreasuryAcceptance(address caller, address pending);
    error RouterPaused();
    error RouterNotPaused();
    error AdapterNotEnabled(address adapter);
    error AdapterInterfaceMismatch(address adapter);
    error AdapterConfigurationChanged(
        address adapter,
        bytes32 expected,
        bytes32 actual
    );
    error AdapterConfigHashMismatch(bytes32 expected, bytes32 actual);
    error RuntimeCodeChanged(address account, bytes32 expected, bytes32 actual);
    error InvalidIntentOwner();
    error InvalidRecipient();
    error ForbiddenRecipient(address recipient);
    error TreasuryTokenCollision(address treasury, address token);
    error InvalidAmount();
    error IdenticalNormalizedTokens();
    error InvalidIntentTimeRange();
    error IntentNotYetValid(uint48 validAfter);
    error IntentExpired(uint48 deadline);
    error IntentTtlTooLong(uint48 supplied, uint48 maximum);
    error WrongExecutor(address expected, address actual);
    error AdapterDataHashMismatch(bytes32 expected, bytes32 actual);
    error FeeLimitExceeded(uint16 currentFeeBps, uint16 maximumFeeBps);
    error FeeAboveHardCap(uint16 supplied, uint16 maximum);
    error InvalidNativeValue(uint256 expected, uint256 actual);
    error RelayedNativeInputUnsupported();
    error InvalidSignature();
    error CounterfactualSignatureUnsupported();
    error NonceAlreadyUsed(address intentOwner, uint256 nonce);
    error InvalidNonceWord(uint256 wordPosition);
    error EmptyNonceMask();
    error UnsupportedTokenBehavior(address token, uint256 expectedDelta, uint256 actualDelta);
    error InsufficientOutput(uint256 minimum, uint256 actual);
    error AdapterReturnedUnexpectedTarget(address expected, address actual);
    error AdapterReturnedUnexpectedSpender(address expected, address actual);
    error AdapterCallFailed(bytes returnData);
    error ResidualAllowance(address token, address spender, uint256 allowance);
    error UnexpectedRouterBalance(address token, uint256 expected, uint256 actual);
    error RecipientTransferFailed(address recipient, uint256 amount);
    error RenounceOwnershipDisabled();

    event GuardianUpdated(address indexed previousGuardian, address indexed newGuardian);
    event TreasuryProposed(address indexed currentTreasury, address indexed pendingTreasury);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event FeeUpdated(uint16 previousFeeBps, uint16 newFeeBps);
    event RouterPausedBy(address indexed account);
    event RouterUnpaused(address indexed governance);
    event AdapterConfigured(
        address indexed adapter,
        address indexed target,
        address indexed spender,
        bytes32 configHash,
        bool enabled
    );
    event AdapterDisabled(address indexed adapter, address indexed account);
    event AdapterEnabled(address indexed adapter);
    event NoncesInvalidated(address indexed intentOwner, uint256 indexed wordPosition, uint256 mask);
    event SwapExecuted(
        bytes32 indexed intentHash,
        address indexed intentOwner,
        address indexed recipient,
        address adapter,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 grossAmountOut,
        uint256 feeAmount,
        uint256 netAmountOut,
        uint256 nonce,
        address executor
    );
    event TokenRescued(address indexed token, address indexed recipient, uint256 amount);
    event NativeRescued(address indexed recipient, uint256 amount);

    modifier onlyGuardianOrOwner() {
        if (msg.sender != guardian && msg.sender != owner()) {
            revert UnauthorizedGuardian(msg.sender);
        }
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert RouterPaused();
        _;
    }

    modifier onlyWhenPaused() {
        if (!paused) revert RouterNotPaused();
        _;
    }

    constructor(
        address initialOwner,
        address initialGuardian,
        address wrappedNative_,
        address initialTreasury,
        uint16 initialFeeBps
    ) EIP712("Kletia Intent Router", "2") Ownable(initialOwner) {
        if (
            initialGuardian == address(0) ||
            wrappedNative_ == address(0) ||
            initialTreasury == address(0) ||
            initialTreasury == address(this) ||
            initialTreasury == wrappedNative_
        ) revert InvalidAddress();
        if (initialFeeBps > MAX_FEE_BPS) {
            revert FeeAboveHardCap(initialFeeBps, MAX_FEE_BPS);
        }

        if (wrappedNative_.code.length == 0) {
            revert ContractCodeRequired(wrappedNative_);
        }
        bytes32 wethCodehash = _codehash(wrappedNative_);

        guardian = initialGuardian;
        wrappedNative = wrappedNative_;
        wrappedNativeCodehash = wethCodehash;
        isSystemAddress[wrappedNative_] = true;
        treasury = initialTreasury;
        feeBps = initialFeeBps;
    }

    receive() external payable {
        if (msg.sender != wrappedNative) revert InvalidNativeValue(0, msg.value);
    }

    function hashSwapIntent(SwapIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(_hashSwapIntentStruct(intent));
    }

        function hashBridgeIntent(BridgeIntent calldata intent) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(BRIDGE_INTENT_TYPEHASH, intent)));
    }

    function executeSwap(
        SwapIntent calldata intent,
        bytes calldata adapterData
    ) external payable nonReentrant whenNotPaused returns (uint256 netAmountOut, uint256 feeAmount) {
        if (msg.sender != intent.owner) revert InvalidIntentOwner();
        _validateIntent(intent, adapterData);
        _validateNativeValue(intent, false);
        _consumeNonce(intent.owner, intent.nonce);
        return _settleSwap(intent, adapterData);
    }

    function executeSwapWithSignature(
        SwapIntent calldata intent,
        bytes calldata adapterData,
        bytes calldata signature
    ) external payable nonReentrant whenNotPaused returns (uint256 netAmountOut, uint256 feeAmount) {
        _validateIntent(intent, adapterData);
        _validateNativeValue(intent, true);

        if (_hasERC6492Suffix(signature)) revert CounterfactualSignatureUnsupported();
        bytes32 digest = hashSwapIntent(intent);
        if (!SignatureChecker.isValidSignatureNowCalldata(intent.owner, digest, signature)) {
            revert InvalidSignature();
        }

        _consumeNonce(intent.owner, intent.nonce);
        return _settleSwap(intent, adapterData);
    }

    function isNonceUsed(address intentOwner, uint256 nonce) public view returns (bool) {
        (uint256 wordPosition, uint256 bit) = _noncePosition(nonce);
        return (_nonceBitmap[intentOwner][wordPosition] & bit) != 0;
    }

    function invalidateUnorderedNonces(uint256 wordPosition, uint256 mask) external {
        if (wordPosition > type(uint248).max) revert InvalidNonceWord(wordPosition);
        if (mask == 0) revert EmptyNonceMask();
        _nonceBitmap[msg.sender][wordPosition] |= mask;
        emit NoncesInvalidated(msg.sender, wordPosition, mask);
    }

    function configureAdapter(address adapter, bool enableImmediately) external onlyOwner {
        if (adapter == address(0)) revert InvalidAddress();
        bytes32 adapterHash = _codehash(adapter);
        if (adapter.code.length == 0) revert ContractCodeRequired(adapter);

        IKletiaSwapAdapterV2 typedAdapter = IKletiaSwapAdapterV2(adapter);
        if (typedAdapter.actionKind() != SWAP_ACTION_KIND) {
            revert AdapterInterfaceMismatch(adapter);
        }

        address target = typedAdapter.target();
        address spender = typedAdapter.spender();
        if (target == address(0) || spender == address(0)) revert AdapterInterfaceMismatch(adapter);
        if (
            adapter == treasury ||
            target == treasury ||
            spender == treasury
        ) revert InvalidAddress();

        if (target.code.length == 0) revert ContractCodeRequired(target);
        if (spender.code.length == 0) revert ContractCodeRequired(spender);
        bytes32 targetHash = _codehash(target);
        bytes32 spenderHash = _codehash(spender);
        bytes32 adapterConfigurationHash = typedAdapter.configurationHash();
        if (adapterConfigurationHash == bytes32(0)) {
            revert AdapterInterfaceMismatch(adapter);
        }
        bytes32 configHash = _adapterConfigHash(
            adapter,
            target,
            spender,
            adapterHash,
            targetHash,
            spenderHash,
            adapterConfigurationHash
        );

        adapterConfig[adapter] = AdapterConfig({
            configured: true,
            enabled: enableImmediately,
            target: target,
            spender: spender,
            adapterCodehash: adapterHash,
            targetCodehash: targetHash,
            spenderCodehash: spenderHash,
            adapterConfigurationHash: adapterConfigurationHash,
            configHash: configHash
        });
        isSystemAddress[adapter] = true;
        isSystemAddress[target] = true;
        isSystemAddress[spender] = true;

        emit AdapterConfigured(
            adapter,
            target,
            spender,
            configHash,
            enableImmediately
        );
    }

    function disableAdapter(address adapter) external onlyGuardianOrOwner {
        AdapterConfig storage config = adapterConfig[adapter];
        if (!config.configured) revert AdapterNotEnabled(adapter);
        config.enabled = false;
        emit AdapterDisabled(adapter, msg.sender);
    }

    function enableAdapter(address adapter) external onlyOwner {
        AdapterConfig storage config = adapterConfig[adapter];
        if (!config.configured) revert AdapterNotEnabled(adapter);
        _requireAdapterCode(config, adapter);
        config.enabled = true;
        emit AdapterEnabled(adapter);
    }

    function pause() external onlyGuardianOrOwner {
        if (!paused) {
            paused = true;
            emit RouterPausedBy(msg.sender);
        }
    }

    function unpause() external onlyOwner {
        if (paused) {
            paused = false;
            emit RouterUnpaused(msg.sender);
        }
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert InvalidAddress();
        address previous = guardian;
        guardian = newGuardian;
        emit GuardianUpdated(previous, newGuardian);
    }

    function proposeTreasury(address newTreasury) external onlyOwner {
        _validateTreasury(newTreasury);
        pendingTreasury = newTreasury;
        emit TreasuryProposed(treasury, newTreasury);
    }

    function acceptTreasury() external {
        address newTreasury = pendingTreasury;
        if (msg.sender != newTreasury) {
            revert UnauthorizedTreasuryAcceptance(
                msg.sender,
                newTreasury
            );
        }
        _validateTreasury(newTreasury);
        address previous = treasury;
        treasury = newTreasury;
        pendingTreasury = address(0);
        emit TreasuryUpdated(previous, newTreasury);
    }

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeAboveHardCap(newFeeBps, MAX_FEE_BPS);
        uint16 previous = feeBps;
        feeBps = newFeeBps;
        emit FeeUpdated(previous, newFeeBps);
    }

    function rescueToken(
        address token,
        address recipient,
        uint256 amount
    ) external onlyOwner onlyWhenPaused nonReentrant {
        if (token == address(0) || recipient == address(0) || recipient == address(this)) {
            revert InvalidAddress();
        }
        IERC20(token).safeTransfer(recipient, amount);
        emit TokenRescued(token, recipient, amount);
    }

    function rescueNative(
        address payable recipient,
        uint256 amount
    ) external onlyOwner onlyWhenPaused nonReentrant {
        if (recipient == address(0) || recipient == address(this)) revert InvalidAddress();
        (bool success, ) = recipient.call{value: amount}("");
        if (!success) revert RecipientTransferFailed(recipient, amount);
        emit NativeRescued(recipient, amount);
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceOwnershipDisabled();
    }

    function _validateIntent(SwapIntent calldata intent, bytes calldata adapterData) private view {
        if (intent.owner == address(0)) revert InvalidIntentOwner();
        if (intent.recipient == address(0) || intent.recipient == address(this)) {
            revert InvalidRecipient();
        }
        if (intent.amountIn == 0 || intent.minAmountOut == 0) {
            revert InvalidAmount();
        }

        address normalizedIn = _normalizeToken(intent.tokenIn);
        address normalizedOut = _normalizeToken(intent.tokenOut);
        if (normalizedIn == normalizedOut) revert IdenticalNormalizedTokens();
        if (normalizedIn.code.length == 0) revert ContractCodeRequired(normalizedIn);
        if (normalizedOut.code.length == 0) revert ContractCodeRequired(normalizedOut);
        if (treasury == normalizedIn) {
            revert TreasuryTokenCollision(treasury, normalizedIn);
        }
        if (treasury == normalizedOut) {
            revert TreasuryTokenCollision(treasury, normalizedOut);
        }
        _requireWrappedNativeCodehash(normalizedIn, normalizedOut);

        if (
            intent.issuedAt > intent.validAfter ||
            intent.validAfter > intent.deadline ||
            intent.issuedAt > block.timestamp
        ) revert InvalidIntentTimeRange();
        uint48 ttl = intent.deadline - intent.issuedAt;
        if (ttl > MAX_INTENT_TTL) revert IntentTtlTooLong(ttl, MAX_INTENT_TTL);
        if (block.timestamp < intent.validAfter) revert IntentNotYetValid(intent.validAfter);
        if (block.timestamp > intent.deadline) revert IntentExpired(intent.deadline);

        if (intent.executor != address(0) && intent.executor != msg.sender) {
            revert WrongExecutor(intent.executor, msg.sender);
        }

        bytes32 actualDataHash = keccak256(adapterData);
        if (actualDataHash != intent.adapterDataHash) {
            revert AdapterDataHashMismatch(intent.adapterDataHash, actualDataHash);
        }
        if (intent.maxFeeBps > MAX_FEE_BPS) {
            revert FeeAboveHardCap(intent.maxFeeBps, MAX_FEE_BPS);
        }
        if (feeBps > intent.maxFeeBps) revert FeeLimitExceeded(feeBps, intent.maxFeeBps);
        if (isNonceUsed(intent.owner, intent.nonce)) {
            revert NonceAlreadyUsed(intent.owner, intent.nonce);
        }

        AdapterConfig storage config = adapterConfig[intent.adapter];
        if (!config.configured || !config.enabled) revert AdapterNotEnabled(intent.adapter);
        if (intent.adapterConfigHash != config.configHash) {
            revert AdapterConfigHashMismatch(
                config.configHash,
                intent.adapterConfigHash
            );
        }
        if (
            isSystemAddress[intent.recipient] ||
            intent.recipient == normalizedIn ||
            intent.recipient == normalizedOut
        ) {
            revert ForbiddenRecipient(intent.recipient);
        }
        _requireAdapterCode(config, intent.adapter);
    }

    function _validateNativeValue(SwapIntent calldata intent, bool relayed) private view {
        if (relayed && intent.tokenIn == address(0)) revert RelayedNativeInputUnsupported();
        uint256 expected = intent.tokenIn == address(0) ? intent.amountIn : 0;
        if (msg.value != expected) revert InvalidNativeValue(expected, msg.value);
    }

    function _settleSwap(
        SwapIntent calldata intent,
        bytes calldata adapterData
    ) private returns (uint256 netAmountOut, uint256 feeAmount) {
        SettlementCache memory cache;
        cache.tokenIn = _normalizeToken(intent.tokenIn);
        cache.tokenOut = _normalizeToken(intent.tokenOut);
        cache.inputBaseline = IERC20(cache.tokenIn).balanceOf(address(this));
        if (intent.tokenIn == address(0)) {
            IWETH9(wrappedNative).deposit{value: intent.amountIn}();
        } else {
            IERC20(cache.tokenIn).safeTransferFrom(intent.owner, address(this), intent.amountIn);
        }
        _requireBalanceDelta(cache.tokenIn, cache.inputBaseline, intent.amountIn);

        cache.outputBaseline = IERC20(cache.tokenOut).balanceOf(address(this));
        uint256 requiredGrossOutput = _requiredGrossOutput(
            intent.minAmountOut,
            feeBps
        );

        _callAdapter(intent, adapterData, cache, requiredGrossOutput);

        uint256 finalInputBalance = IERC20(cache.tokenIn).balanceOf(address(this));
        if (finalInputBalance != cache.inputBaseline) {
            uint256 actualSpent = finalInputBalance <= cache.inputBaseline + intent.amountIn
                ? cache.inputBaseline + intent.amountIn - finalInputBalance
                : 0;
            revert UnsupportedTokenBehavior(cache.tokenIn, intent.amountIn, actualSpent);
        }

        uint256 finalOutputBalance = IERC20(cache.tokenOut).balanceOf(address(this));
        if (finalOutputBalance < cache.outputBaseline) {
            revert UnsupportedTokenBehavior(
                cache.tokenOut,
                0,
                cache.outputBaseline - finalOutputBalance
            );
        }
        cache.grossAmountOut = finalOutputBalance - cache.outputBaseline;
        if (cache.grossAmountOut == 0) revert InsufficientOutput(1, 0);
        feeAmount = Math.mulDiv(cache.grossAmountOut, feeBps, BPS_DENOMINATOR);
        netAmountOut = cache.grossAmountOut - feeAmount;
        if (netAmountOut < intent.minAmountOut) {
            revert InsufficientOutput(intent.minAmountOut, netAmountOut);
        }

        _distributeOutput(
            intent,
            cache.tokenOut,
            cache.grossAmountOut,
            netAmountOut,
            feeAmount
        );
        _requireExactRouterBalance(
            cache.tokenOut,
            cache.outputBaseline
        );

        _emitSwapExecuted(intent, cache.grossAmountOut, feeAmount, netAmountOut);
    }

    function _callAdapter(
        SwapIntent calldata intent,
        bytes calldata adapterData,
        SettlementCache memory cache,
        uint256 requiredGrossOutput
    ) private {
        AdapterConfig storage config = adapterConfig[intent.adapter];
        IKletiaSwapAdapterV2.SwapCall memory swapCall = IKletiaSwapAdapterV2.SwapCall({
            tokenIn: cache.tokenIn,
            tokenOut: cache.tokenOut,
            amountIn: intent.amountIn,
            minAmountOut: requiredGrossOutput,
            recipient: address(this),
            deadline: intent.deadline
        });

        (address callTarget, address allowanceSpender, bytes memory callData) = IKletiaSwapAdapterV2(
            intent.adapter
        ).buildSwapCalldata(swapCall, adapterData);

        if (callTarget != config.target) {
            revert AdapterReturnedUnexpectedTarget(config.target, callTarget);
        }
        if (allowanceSpender != config.spender) {
            revert AdapterReturnedUnexpectedSpender(config.spender, allowanceSpender);
        }
        _requireAdapterCode(config, intent.adapter);

        IERC20(cache.tokenIn).forceApprove(allowanceSpender, intent.amountIn);
        (bool success, bytes memory returnData) = callTarget.call(callData);
        if (!success) revert AdapterCallFailed(returnData);
        IERC20(cache.tokenIn).forceApprove(allowanceSpender, 0);
        uint256 remainingAllowance = IERC20(cache.tokenIn).allowance(
            address(this),
            allowanceSpender
        );
        if (remainingAllowance != 0) {
            revert ResidualAllowance(
                cache.tokenIn,
                allowanceSpender,
                remainingAllowance
            );
        }

        _requireAdapterCode(config, intent.adapter);
    }

    function _emitSwapExecuted(
        SwapIntent calldata intent,
        uint256 grossAmountOut,
        uint256 feeAmount,
        uint256 netAmountOut
    ) private {
        emit SwapExecuted(
            hashSwapIntent(intent),
            intent.owner,
            intent.recipient,
            intent.adapter,
            intent.tokenIn,
            intent.tokenOut,
            intent.amountIn,
            grossAmountOut,
            feeAmount,
            netAmountOut,
            intent.nonce,
            msg.sender
        );
    }

    function _distributeOutput(
        SwapIntent calldata intent,
        address tokenOut,
        uint256 grossAmountOut,
        uint256 netAmountOut,
        uint256 feeAmount
    ) private {
        if (intent.tokenOut == address(0)) {
            if (feeAmount != 0) _transferExactToken(tokenOut, treasury, feeAmount);
            IWETH9(wrappedNative).withdraw(netAmountOut);
            (bool success, ) = payable(intent.recipient).call{value: netAmountOut}("");
            if (!success) revert RecipientTransferFailed(intent.recipient, netAmountOut);
            return;
        }

        if (treasury == intent.recipient) {
            uint256 recipientBefore = IERC20(tokenOut).balanceOf(intent.recipient);
            if (feeAmount != 0) IERC20(tokenOut).safeTransfer(treasury, feeAmount);
            IERC20(tokenOut).safeTransfer(intent.recipient, netAmountOut);
            _requireExternalBalanceDelta(tokenOut, intent.recipient, recipientBefore, grossAmountOut);
            return;
        }

        if (feeAmount != 0) _transferExactToken(tokenOut, treasury, feeAmount);
        _transferExactToken(tokenOut, intent.recipient, netAmountOut);
    }

    function _transferExactToken(address token, address recipient, uint256 amount) private {
        uint256 beforeBalance = IERC20(token).balanceOf(recipient);
        IERC20(token).safeTransfer(recipient, amount);
        _requireExternalBalanceDelta(token, recipient, beforeBalance, amount);
    }

    function _requireBalanceDelta(address token, uint256 beforeBalance, uint256 expectedDelta) private view {
        uint256 afterBalance = IERC20(token).balanceOf(address(this));
        uint256 actualDelta = afterBalance >= beforeBalance ? afterBalance - beforeBalance : 0;
        if (actualDelta != expectedDelta) {
            revert UnsupportedTokenBehavior(token, expectedDelta, actualDelta);
        }
    }

    function _requireExactRouterBalance(
        address token,
        uint256 expectedBalance
    ) private view {
        uint256 actualBalance = IERC20(token).balanceOf(address(this));
        if (actualBalance != expectedBalance) {
            revert UnexpectedRouterBalance(
                token,
                expectedBalance,
                actualBalance
            );
        }
    }

    /**
     * @dev Returns the exact smallest gross amount whose post-fee balance is at
     *      least netMinimum. Since `gross - floor(gross * fee / D)` equals
     *      `ceil(gross * (D - fee) / D)`, the strict lower-bound form avoids
     *      the one-unit overestimate produced by a continuous-rate ceiling.
     */
    function _requiredGrossOutput(
        uint256 netMinimum,
        uint16 appliedFeeBps
    ) private pure returns (uint256) {
        return
            Math.mulDiv(
                netMinimum - 1,
                BPS_DENOMINATOR,
                BPS_DENOMINATOR - appliedFeeBps
            ) +
            1;
    }

    function _requireExternalBalanceDelta(
        address token,
        address account,
        uint256 beforeBalance,
        uint256 expectedDelta
    ) private view {
        uint256 afterBalance = IERC20(token).balanceOf(account);
        uint256 actualDelta = afterBalance >= beforeBalance ? afterBalance - beforeBalance : 0;
        if (actualDelta != expectedDelta) {
            revert UnsupportedTokenBehavior(token, expectedDelta, actualDelta);
        }
    }

    function _consumeNonce(address intentOwner, uint256 nonce) private {
        (uint256 wordPosition, uint256 bit) = _noncePosition(nonce);
        uint256 word = _nonceBitmap[intentOwner][wordPosition];
        if (word & bit != 0) revert NonceAlreadyUsed(intentOwner, nonce);
        _nonceBitmap[intentOwner][wordPosition] = word | bit;
    }

    function _noncePosition(uint256 nonce) private pure returns (uint256 wordPosition, uint256 bit) {
        wordPosition = nonce >> 8;
        bit = uint256(1) << uint8(nonce);
    }

    function _hashSwapIntentStruct(SwapIntent calldata intent) private pure returns (bytes32) {
        return keccak256(abi.encode(SWAP_INTENT_TYPEHASH, intent));
    }

    function _requireAdapterCode(AdapterConfig storage config, address adapter) private view {
        _requireCodehash(adapter, config.adapterCodehash);
        _requireCodehash(config.target, config.targetCodehash);
        _requireCodehash(config.spender, config.spenderCodehash);
        IKletiaSwapAdapterV2 typedAdapter = IKletiaSwapAdapterV2(adapter);
        if (
            typedAdapter.actionKind() != SWAP_ACTION_KIND ||
            typedAdapter.target() != config.target ||
            typedAdapter.spender() != config.spender
        ) {
            revert AdapterInterfaceMismatch(adapter);
        }
        bytes32 actualConfigurationHash =
            typedAdapter.configurationHash();
        if (
            actualConfigurationHash !=
            config.adapterConfigurationHash
        ) {
            revert AdapterConfigurationChanged(
                adapter,
                config.adapterConfigurationHash,
                actualConfigurationHash
            );
        }
    }

    function _requireWrappedNativeCodehash(address tokenIn, address tokenOut) private view {
        if (tokenIn == wrappedNative || tokenOut == wrappedNative) {
            _requireCodehash(wrappedNative, wrappedNativeCodehash);
        }
    }

    function _normalizeToken(address token) private view returns (address) {
        return token == address(0) ? wrappedNative : token;
    }

    function _hasERC6492Suffix(bytes calldata signature) private pure returns (bool) {
        if (signature.length < 32) return false;
        bytes32 suffix;
        assembly ("memory-safe") {
            suffix := calldataload(add(signature.offset, sub(signature.length, 32)))
        }
        return suffix == ERC6492_MAGIC;
    }

    function _requireCodehash(address account, bytes32 expected) private view {
        if (account.code.length == 0) {
            revert ContractCodeRequired(account);
        }
        bytes32 actual = _codehash(account);
        if (actual != expected) revert RuntimeCodeChanged(account, expected, actual);
    }

    function _adapterConfigHash(
        address adapter,
        address target,
        address spender,
        bytes32 adapterCodehash,
        bytes32 targetCodehash,
        bytes32 spenderCodehash,
        bytes32 adapterConfigurationHash
    ) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SWAP_ACTION_KIND,
                adapter,
                target,
                spender,
                adapterCodehash,
                targetCodehash,
                spenderCodehash,
                adapterConfigurationHash
            )
        );
    }

    function _validateTreasury(
        address candidate
    ) private view {
        if (
            candidate == address(0) ||
            candidate == address(this) ||
            candidate == wrappedNative ||
            isSystemAddress[candidate]
        ) revert InvalidAddress();
    }

    function _codehash(address account) private view returns (bytes32 result) {
        assembly ("memory-safe") {
            result := extcodehash(account)
        }
    }
}
