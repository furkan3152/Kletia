// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

/**
 * @title KletiaArcVault
 * @author Kletia Team
 * @notice Native USDC Vault with simple compounding APY for the ARC Network.
 * @dev Users deposit Native USDC (msg.value) and earn interest over time based on an
 *      owner-defined APY. Both principal and interest are paid out in Native USDC.
 *
 *      Chain ID: 311614
 */
contract KletiaArcVault is ERC2771Context {
    // ──────────────────────── State ────────────────────────

    address public owner;

    /// @notice Annual Percentage Yield in basis points (e.g., 500 = 5%).
    uint256 public apyBps;

    uint256 private constant BPS_DENOMINATOR = 10000;
    uint256 private constant SECONDS_PER_YEAR = 31536000;

    struct Deposit {
        uint256 principal;
        uint256 lastAccrualTimestamp;
        uint256 accruedInterest;
    }

    /// @notice Per-user deposit data.
    mapping(address => Deposit) public deposits;

    /// @notice Total principal deposited across all users.
    uint256 public totalDeposited;

    // Reentrancy guard
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    // ──────────────────────── Events ───────────────────────

    event Deposited(address indexed user, uint256 amount, uint256 totalPrincipal);
    event Withdrawn(address indexed user, uint256 principal, uint256 interest, uint256 totalPayout);
    event EmergencyWithdrawn(address indexed user, uint256 principal, uint256 forfeitedInterest);
    event APYUpdated(uint256 oldAPY, uint256 newAPY);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event VaultFunded(address indexed funder, uint256 amount);

    // ──────────────────────── Modifiers ────────────────────

    modifier onlyOwner() {
        require(_msgSender() == owner, "KletiaArcVault: caller is not the owner");
        _;
    }

    modifier nonReentrant() {
        require(_status != _ENTERED, "KletiaArcVault: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    // ──────────────────────── Constructor ──────────────────

    /**
     * @param _apyBps  Initial APY in basis points (e.g., 500 = 5%).
     */
    constructor(address trustedForwarder, uint256 _apyBps) ERC2771Context(trustedForwarder) {
        require(_apyBps <= 5000, "KletiaArcVault: APY too high"); // max 50%

        owner = _msgSender();
        apyBps = _apyBps;
        _status = _NOT_ENTERED;

        emit OwnershipTransferred(address(0), _msgSender());
        emit APYUpdated(0, _apyBps);
    }

    // ──────────────────────── Receive ────────────────────────

    /// @notice Allow contract to receive native USDC directly for funding.
    receive() external payable {
        emit VaultFunded(_msgSender(), msg.value);
    }

    // ──────────────────────── User Functions ───────────────

    /**
     * @notice Deposit Native USDC into the vault.
     * @dev If user has an existing deposit, accrued interest is snapshotted
     *      before the new principal is added.
     */
    function deposit() external payable nonReentrant {
        uint256 amount = msg.value;
        require(amount > 0, "KletiaArcVault: amount must be > 0");

        Deposit storage d = deposits[_msgSender()];

        // Snapshot accrued interest on existing principal before updating
        if (d.principal > 0) {
            d.accruedInterest += _calculateInterest(d.principal, d.lastAccrualTimestamp);
        }

        d.principal += amount;
        d.lastAccrualTimestamp = block.timestamp;
        totalDeposited += amount;

        emit Deposited(_msgSender(), amount, d.principal);
    }

    /**
     * @notice Withdraw full principal + all accrued interest.
     * @dev Reverts if the vault has insufficient Native USDC to pay interest.
     */
    function withdraw() external nonReentrant {
        Deposit storage d = deposits[_msgSender()];
        require(d.principal > 0, "KletiaArcVault: no active deposit");

        uint256 interest = d.accruedInterest + _calculateInterest(d.principal, d.lastAccrualTimestamp);
        uint256 principal = d.principal;
        uint256 totalPayout = principal + interest;

        if (address(this).balance < totalPayout) {
            uint256 availableInterest = address(this).balance > principal ? address(this).balance - principal : 0;
            totalPayout = principal + availableInterest;
            interest = availableInterest;
        }

        // Clear state before transfer (CEI pattern)
        unchecked {
            totalDeposited -= principal;
        }
        d.principal = 0;
        d.accruedInterest = 0;
        d.lastAccrualTimestamp = 0;

        (bool success, ) = payable(_msgSender()).call{value: totalPayout}("");
        require(success, "KletiaArcVault: USDC native transfer failed");

        emit Withdrawn(_msgSender(), principal, interest, totalPayout);
    }

    /**
     * @notice Emergency withdraw principal only — all accrued interest is forfeited.
     */
    function emergencyWithdraw() external nonReentrant {
        Deposit storage d = deposits[_msgSender()];
        require(d.principal > 0, "KletiaArcVault: no active deposit");

        uint256 principal = d.principal;
        uint256 forfeited = d.accruedInterest + _calculateInterest(principal, d.lastAccrualTimestamp);

        // Clear state before transfer
        unchecked {
            totalDeposited -= principal;
        }
        d.principal = 0;
        d.accruedInterest = 0;
        d.lastAccrualTimestamp = 0;

        (bool success, ) = payable(_msgSender()).call{value: principal}("");
        require(success, "KletiaArcVault: USDC native transfer failed");

        emit EmergencyWithdrawn(_msgSender(), principal, forfeited);
    }

    // ──────────────────────── Admin ────────────────────────

    /**
     * @notice Update the APY rate.
     * @param newApyBps New APY in basis points (max 50%).
     */
    function setAPY(uint256 newApyBps) external onlyOwner {
        require(newApyBps <= 5000, "KletiaArcVault: APY too high");
        uint256 oldApy = apyBps;
        apyBps = newApyBps;
        emit APYUpdated(oldApy, newApyBps);
    }

    /**
     * @notice Owner funds the vault with Native USDC to cover interest payments.
     */
    function fundVault() external payable onlyOwner {
        require(msg.value > 0, "KletiaArcVault: amount must be > 0");
        emit VaultFunded(_msgSender(), msg.value);
    }

    /**
     * @notice Transfer contract ownership.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "KletiaArcVault: invalid new owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ──────────────────────── Views ────────────────────────

    /**
     * @notice Returns the pending (unclaimed) interest for a user.
     */
    function pendingInterest(address user) external view returns (uint256) {
        Deposit storage d = deposits[user];
        if (d.principal == 0) return 0;
        return d.accruedInterest + _calculateInterest(d.principal, d.lastAccrualTimestamp);
    }

    /**
     * @notice Returns the total claimable amount (principal + interest).
     */
    function claimableAmount(address user) external view returns (uint256) {
        Deposit storage d = deposits[user];
        if (d.principal == 0) return 0;
        return d.principal + d.accruedInterest + _calculateInterest(d.principal, d.lastAccrualTimestamp);
    }

    /**
     * @notice Returns the vault's total Native USDC balance (principal + reserve for interest).
     */
    function vaultBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // ──────────────────────── Internal ─────────────────────

    /**
     * @dev Calculates simple interest accrued since `since` on `principal`.
     *      interest = principal * apyBps * elapsed / (BPS_DENOMINATOR * SECONDS_PER_YEAR)
     */
    function _calculateInterest(uint256 principal, uint256 since) internal view returns (uint256) {
        if (since == 0 || principal == 0) return 0;
        uint256 elapsed;
        unchecked {
            elapsed = block.timestamp - since;
        }
        return (principal * apyBps * elapsed) / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
    }
}
