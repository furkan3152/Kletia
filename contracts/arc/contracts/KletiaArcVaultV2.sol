// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Principal-protected native-USDC savings vault for Arc Testnet.
/// @dev Normal withdrawals require full global solvency. Emergency withdrawals
///      can forfeit interest but can never consume another user's principal.
contract KletiaArcVaultV2 is
    ERC2771Context,
    Ownable2Step,
    Pausable,
    ReentrancyGuard
{
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant INTEREST_INDEX_SCALE = 1e27;
    uint256 public constant MAX_APY_BPS = 5_000;

    struct Deposit {
        uint256 principal;
        uint256 indexCheckpoint;
        uint256 accruedInterest;
    }

    mapping(address user => Deposit depositState) public deposits;

    address public guardian;
    uint256 public apyBps;
    uint256 public totalDeposited;
    uint256 public totalInterestLiability;
    uint256 public globalInterestIndex;
    uint256 public lastGlobalAccrualTimestamp;

    error InvalidAddress();
    error InvalidAmount();
    error APYAboveMaximum(uint256 supplied, uint256 maximum);
    error NoActiveDeposit(address user);
    error UnauthorizedGuardian(address caller);
    error VaultInsolvent(uint256 balance, uint256 requiredReserve);
    error PrincipalReserveBreached(uint256 balance, uint256 principalReserve);
    error InterestLiabilityInvariant(uint256 liability, uint256 accountInterest);
    error NativeTransferFailed(address recipient, uint256 amount);
    error RenounceOwnershipDisabled();

    event Deposited(address indexed user, uint256 amount, uint256 totalPrincipal);
    event Withdrawn(
        address indexed user,
        uint256 principal,
        uint256 interest,
        uint256 totalPayout
    );
    event EmergencyWithdrawn(
        address indexed user,
        uint256 principal,
        uint256 forfeitedInterest
    );
    event APYUpdated(uint256 oldAPY, uint256 newAPY);
    event GuardianUpdated(address indexed previousGuardian, address indexed newGuardian);
    event VaultFunded(address indexed funder, uint256 amount);

    modifier onlyGuardianOrOwner() {
        address sender = _msgSender();
        if (sender != guardian && sender != owner()) {
            revert UnauthorizedGuardian(sender);
        }
        _;
    }

    constructor(
        address trustedForwarder,
        address initialOwner,
        address initialGuardian,
        uint256 initialApyBps
    ) ERC2771Context(trustedForwarder) Ownable(initialOwner) {
        if (
            trustedForwarder == address(0) ||
            initialOwner == address(0) ||
            initialGuardian == address(0)
        ) revert InvalidAddress();
        if (trustedForwarder.code.length == 0) revert InvalidAddress();
        if (initialApyBps > MAX_APY_BPS) {
            revert APYAboveMaximum(initialApyBps, MAX_APY_BPS);
        }

        guardian = initialGuardian;
        apyBps = initialApyBps;
        lastGlobalAccrualTimestamp = block.timestamp;

        emit GuardianUpdated(address(0), initialGuardian);
        emit APYUpdated(0, initialApyBps);
    }

    receive() external payable {
        if (msg.value == 0) revert InvalidAmount();
        emit VaultFunded(_msgSender(), msg.value);
    }

    function deposit() external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert InvalidAmount();

        address user = _msgSender();
        _accrueGlobal();
        _accrueAccount(user);

        Deposit storage account = deposits[user];
        account.principal += msg.value;
        account.indexCheckpoint = globalInterestIndex;
        totalDeposited += msg.value;

        emit Deposited(user, msg.value, account.principal);
    }

    function withdraw() external nonReentrant {
        address user = _msgSender();
        _accrueGlobal();
        _accrueAccount(user);

        Deposit memory account = deposits[user];
        if (account.principal == 0) revert NoActiveDeposit(user);

        uint256 required = totalDeposited + totalInterestLiability;
        uint256 balance = address(this).balance;
        if (balance < required) revert VaultInsolvent(balance, required);
        if (totalInterestLiability < account.accruedInterest) {
            revert InterestLiabilityInvariant(
                totalInterestLiability,
                account.accruedInterest
            );
        }

        totalDeposited -= account.principal;
        totalInterestLiability -= account.accruedInterest;
        if (totalDeposited == 0) totalInterestLiability = 0;
        delete deposits[user];

        uint256 payout = account.principal + account.accruedInterest;
        _sendNative(user, payout);

        emit Withdrawn(
            user,
            account.principal,
            account.accruedInterest,
            payout
        );
    }

    function emergencyWithdraw() external nonReentrant {
        address user = _msgSender();
        _accrueGlobal();
        _accrueAccount(user);

        Deposit memory account = deposits[user];
        if (account.principal == 0) revert NoActiveDeposit(user);

        uint256 balance = address(this).balance;
        if (balance < totalDeposited) {
            revert PrincipalReserveBreached(balance, totalDeposited);
        }
        if (totalInterestLiability < account.accruedInterest) {
            revert InterestLiabilityInvariant(
                totalInterestLiability,
                account.accruedInterest
            );
        }

        totalDeposited -= account.principal;
        totalInterestLiability -= account.accruedInterest;
        if (totalDeposited == 0) totalInterestLiability = 0;
        delete deposits[user];

        _sendNative(user, account.principal);
        emit EmergencyWithdrawn(
            user,
            account.principal,
            account.accruedInterest
        );
    }

    function fundVault() external payable {
        if (msg.value == 0) revert InvalidAmount();
        emit VaultFunded(_msgSender(), msg.value);
    }

    function setAPY(uint256 newApyBps) external onlyOwner {
        if (newApyBps > MAX_APY_BPS) {
            revert APYAboveMaximum(newApyBps, MAX_APY_BPS);
        }
        _accrueGlobal();
        uint256 previous = apyBps;
        apyBps = newApyBps;
        emit APYUpdated(previous, newApyBps);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert InvalidAddress();
        address previous = guardian;
        guardian = newGuardian;
        emit GuardianUpdated(previous, newGuardian);
    }

    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceOwnershipDisabled();
    }

    function pendingInterest(address user) public view returns (uint256) {
        Deposit storage account = deposits[user];
        if (account.principal == 0) return 0;
        uint256 previewIndex = _previewGlobalIndex();
        return
            account.accruedInterest +
            Math.mulDiv(
                account.principal,
                previewIndex - account.indexCheckpoint,
                INTEREST_INDEX_SCALE
            );
    }

    function claimableAmount(address user) external view returns (uint256) {
        return deposits[user].principal + pendingInterest(user);
    }

    function requiredReserve() public view returns (uint256) {
        if (totalDeposited == 0) return 0;
        return totalDeposited + _previewInterestLiability();
    }

    function reserveStatus()
        external
        view
        returns (
            uint256 balance,
            uint256 principalLiability,
            uint256 interestLiability,
            uint256 required,
            uint256 surplus,
            bool fullyCollateralized
        )
    {
        balance = address(this).balance;
        principalLiability = totalDeposited;
        interestLiability = _previewInterestLiability();
        required = principalLiability + interestLiability;
        fullyCollateralized = balance >= required;
        surplus = fullyCollateralized ? balance - required : 0;
    }

    function vaultBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function _accrueGlobal() private {
        (uint256 nextIndex, uint256 nextLiability) = _previewGlobalState();
        globalInterestIndex = nextIndex;
        totalInterestLiability = nextLiability;
        lastGlobalAccrualTimestamp = block.timestamp;
    }

    function _accrueAccount(address user) private {
        Deposit storage account = deposits[user];
        if (account.principal != 0) {
            account.accruedInterest += Math.mulDiv(
                account.principal,
                globalInterestIndex - account.indexCheckpoint,
                INTEREST_INDEX_SCALE
            );
        }
        account.indexCheckpoint = globalInterestIndex;
    }

    function _previewGlobalIndex() private view returns (uint256) {
        (uint256 nextIndex, ) = _previewGlobalState();
        return nextIndex;
    }

    function _previewInterestLiability() private view returns (uint256) {
        (, uint256 nextLiability) = _previewGlobalState();
        return nextLiability;
    }

    function _previewGlobalState()
        private
        view
        returns (uint256 nextIndex, uint256 nextLiability)
    {
        nextIndex = globalInterestIndex;
        nextLiability = totalInterestLiability;
        if (totalDeposited == 0 || block.timestamp == lastGlobalAccrualTimestamp) {
            return (nextIndex, nextLiability);
        }

        uint256 elapsed = block.timestamp - lastGlobalAccrualTimestamp;
        uint256 indexDelta = Math.mulDiv(
            apyBps * elapsed,
            INTEREST_INDEX_SCALE,
            BPS_DENOMINATOR * SECONDS_PER_YEAR
        );
        nextIndex += indexDelta;
        if (indexDelta != 0) {
            nextLiability += Math.mulDiv(
                totalDeposited,
                indexDelta,
                INTEREST_INDEX_SCALE,
                Math.Rounding.Ceil
            );
        }
    }

    function _sendNative(address recipient, uint256 amount) private {
        (bool success, ) = payable(recipient).call{value: amount}("");
        if (!success) revert NativeTransferFailed(recipient, amount);
    }

    function _msgSender()
        internal
        view
        override(Context, ERC2771Context)
        returns (address)
    {
        return ERC2771Context._msgSender();
    }

    function _msgData()
        internal
        view
        override(Context, ERC2771Context)
        returns (bytes calldata)
    {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength()
        internal
        view
        override(Context, ERC2771Context)
        returns (uint256)
    {
        return ERC2771Context._contextSuffixLength();
    }
}
