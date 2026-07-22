// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

/**
 * @title KletiaArcStaking
 * @author Kletia Team
 * @notice Native USDC staking contract.
 * @dev Users stake Native USDC and earn Native USDC rewards based on APR.
 *      Chain ID: 311614
 */
contract KletiaArcStaking is ERC2771Context {
    // ──────────────────────── State ────────────────────────

    address public owner;

    /// @notice Annual Percentage Rate in basis points (e.g., 500 = 5%).
    uint256 public aprBps;

    /// @notice Cooldown period before unstaked funds can be claimed (default: 7 days).
    uint256 public cooldownPeriod;

    /// @notice Total USDC staked across all users.
    uint256 public totalStaked;

    /// @notice Total USDC available in the reward pool.
    uint256 public rewardPoolBalance;

    uint256 private constant BPS_DENOMINATOR = 10000;
    uint256 private constant SECONDS_PER_YEAR = 31536000;
    uint256 private constant MAX_APR_BPS = 3000; // 30%
    uint256 private constant MIN_STAKE = 1; // 1 unit (wei-equivalent for native USDC)

    struct StakerInfo {
        uint256 stakedAmount;
        uint256 stakingTimestamp;
        uint256 accruedRewards;
        uint256 pendingUnstake;
        uint256 unstakeRequestTime;
    }

    /// @notice Per-user staking data.
    mapping(address => StakerInfo) public stakers;

    // ──────────────────────── Reentrancy Guard ─────────────

    bool private _locked;

    modifier nonReentrant() {
        require(!_locked, "KletiaArcStaking: reentrant call");
        _locked = true;
        _;
        _locked = false;
    }

    // ──────────────────────── Events ───────────────────────

    event Staked(address indexed user, uint256 amount, uint256 totalUserStake);
    event UnstakeRequested(address indexed user, uint256 amount, uint256 claimableAfter);
    event Unstaked(address indexed user, uint256 amount);
    event RewardsClaimed(address indexed user, uint256 amount);
    event APRUpdated(uint256 oldAPR, uint256 newAPR);
    event RewardsFunded(address indexed funder, uint256 amount, uint256 newPoolBalance);
    event CooldownUpdated(uint256 oldCooldown, uint256 newCooldown);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ──────────────────────── Modifiers ────────────────────

    modifier onlyOwner() {
        require(_msgSender() == owner, "KletiaArcStaking: caller is not the owner");
        _;
    }

    // ──────────────────────── Constructor ──────────────────

    /**
     * @param _aprBps          Initial APR in basis points (e.g., 500 = 5%, max 3000 = 30%).
     * @param _cooldownPeriod  Initial cooldown period in seconds (e.g., 604800 = 7 days).
     */
    constructor(address trustedForwarder, uint256 _aprBps, uint256 _cooldownPeriod) ERC2771Context(trustedForwarder) {
        require(_aprBps <= MAX_APR_BPS, "KletiaArcStaking: APR too high");
        require(_cooldownPeriod > 0, "KletiaArcStaking: cooldown must be > 0");

        owner = _msgSender();
        aprBps = _aprBps;
        cooldownPeriod = _cooldownPeriod;

        emit OwnershipTransferred(address(0), _msgSender());
        emit APRUpdated(0, _aprBps);
    }

    // ──────────────────────── User Functions ───────────────

    /**
     * @notice Stake Native USDC into the staking pool.
     * @dev If user already has a stake, accrued rewards are snapshotted
     *      before updating their stake.
     */
    function stake() external payable nonReentrant {
        uint256 amount = msg.value;
        require(amount >= MIN_STAKE, "KletiaArcStaking: amount too small");

        StakerInfo storage s = stakers[_msgSender()];

        // Snapshot accrued rewards on existing stake before updating
        if (s.stakedAmount > 0) {
            s.accruedRewards += _calculateRewards(s.stakedAmount, s.stakingTimestamp);
        }

        s.stakedAmount += amount;
        s.stakingTimestamp = block.timestamp;
        totalStaked += amount;

        emit Staked(_msgSender(), amount, s.stakedAmount);
    }

    /**
     * @notice Request to unstake a given amount. Starts the cooldown timer.
     * @dev Only one pending unstake at a time. User must claim or cancel before
     *      requesting a new unstake. Accrued rewards are snapshotted.
     * @param amount The amount of staked USDC to unstake.
     */
    function unstake(uint256 amount) external nonReentrant {
        StakerInfo storage s = stakers[_msgSender()];

        require(amount > 0, "KletiaArcStaking: amount must be > 0");
        require(s.stakedAmount >= amount, "KletiaArcStaking: insufficient staked balance");
        require(s.pendingUnstake == 0, "KletiaArcStaking: existing unstake pending");

        // Snapshot rewards before reducing stake
        s.accruedRewards += _calculateRewards(s.stakedAmount, s.stakingTimestamp);

        s.stakedAmount -= amount;
        s.stakingTimestamp = block.timestamp;
        s.pendingUnstake = amount;
        s.unstakeRequestTime = block.timestamp;
        totalStaked -= amount;

        emit UnstakeRequested(_msgSender(), amount, block.timestamp + cooldownPeriod);
    }

    /**
     * @notice Claim unstaked USDC after the cooldown period has elapsed.
     */
    function claimUnstaked() external nonReentrant {
        StakerInfo storage s = stakers[_msgSender()];

        require(s.pendingUnstake > 0, "KletiaArcStaking: no pending unstake");
        require(
            block.timestamp >= s.unstakeRequestTime + cooldownPeriod,
            "KletiaArcStaking: cooldown not elapsed"
        );

        uint256 payout = s.pendingUnstake;

        // Clear state before transfer (CEI pattern)
        s.pendingUnstake = 0;
        s.unstakeRequestTime = 0;

        require(
            address(this).balance >= payout,
            "KletiaArcStaking: insufficient contract balance"
        );

        (bool success, ) = payable(_msgSender()).call{value: payout}("");
        require(success, "KletiaArcStaking: USDC native transfer failed");

        emit Unstaked(_msgSender(), payout);
    }

    /**
     * @notice Claim all accrued staking rewards.
     * @dev Rewards are paid from the reward pool. Reverts if pool is insufficient.
     */
    function claimRewards() external nonReentrant {
        StakerInfo storage s = stakers[_msgSender()];

        uint256 rewards = s.accruedRewards;
        if (s.stakedAmount > 0) {
            rewards += _calculateRewards(s.stakedAmount, s.stakingTimestamp);
            s.stakingTimestamp = block.timestamp;
        }

        require(rewards > 0, "KletiaArcStaking: no rewards to claim");
        require(rewardPoolBalance >= rewards, "KletiaArcStaking: insufficient reward pool");

        // Clear state before transfer (CEI pattern)
        s.accruedRewards = 0;
        rewardPoolBalance -= rewards;

        (bool success, ) = payable(_msgSender()).call{value: rewards}("");
        require(success, "KletiaArcStaking: USDC native transfer failed");

        emit RewardsClaimed(_msgSender(), rewards);
    }

    // ──────────────────────── Admin ────────────────────────

    /**
     * @notice Update the APR rate.
     * @param newAprBps New APR in basis points (max 30%).
     */
    function setAPR(uint256 newAprBps) external onlyOwner {
        require(newAprBps <= MAX_APR_BPS, "KletiaArcStaking: APR too high");
        uint256 oldApr = aprBps;
        aprBps = newAprBps;
        emit APRUpdated(oldApr, newAprBps);
    }

    /**
     * @notice Update the cooldown period.
     * @param newCooldown New cooldown period in seconds.
     */
    function setCooldownPeriod(uint256 newCooldown) external onlyOwner {
        require(newCooldown > 0, "KletiaArcStaking: cooldown must be > 0");
        uint256 oldCooldown = cooldownPeriod;
        cooldownPeriod = newCooldown;
        emit CooldownUpdated(oldCooldown, newCooldown);
    }

    /**
     * @notice Fund the reward pool with Native USDC.
     */
    function fundRewards() external payable onlyOwner {
        require(msg.value > 0, "KletiaArcStaking: amount must be > 0");
        rewardPoolBalance += msg.value;
        emit RewardsFunded(_msgSender(), msg.value, rewardPoolBalance);
    }

    /**
     * @notice Transfer contract ownership.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "KletiaArcStaking: invalid new owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ──────────────────────── Views ────────────────────────

    /**
     * @notice Returns the pending (unclaimed) rewards for a user.
     */
    function pendingRewards(address user) external view returns (uint256) {
        StakerInfo storage s = stakers[user];
        uint256 rewards = s.accruedRewards;
        if (s.stakedAmount > 0) {
            rewards += _calculateRewards(s.stakedAmount, s.stakingTimestamp);
        }
        return rewards;
    }

    /**
     * @notice Returns full staker information for a user.
     */
    function getStakerInfo(address user)
        external
        view
        returns (
            uint256 stakedAmount,
            uint256 stakingTimestamp,
            uint256 accruedRewards,
            uint256 pendingUnstake,
            uint256 unstakeRequestTime,
            uint256 cooldownRemaining
        )
    {
        StakerInfo storage s = stakers[user];
        stakedAmount = s.stakedAmount;
        stakingTimestamp = s.stakingTimestamp;
        pendingUnstake = s.pendingUnstake;
        unstakeRequestTime = s.unstakeRequestTime;

        // Include live accrued rewards
        accruedRewards = s.accruedRewards;
        if (s.stakedAmount > 0) {
            accruedRewards += _calculateRewards(s.stakedAmount, s.stakingTimestamp);
        }

        // Calculate remaining cooldown
        if (s.pendingUnstake > 0) {
            uint256 unlockTime = s.unstakeRequestTime + cooldownPeriod;
            cooldownRemaining = block.timestamp >= unlockTime ? 0 : unlockTime - block.timestamp;
        }
    }

    /**
     * @notice Returns the contract's total Native USDC balance.
     */
    function contractBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // ──────────────────────── Internal ─────────────────────

    /**
     * @dev Calculates simple rewards accrued since `since` on `staked`.
     *      rewards = staked * aprBps * elapsed / (BPS_DENOMINATOR * SECONDS_PER_YEAR)
     */
    function _calculateRewards(uint256 staked, uint256 since) internal view returns (uint256) {
        if (since == 0 || staked == 0) return 0;
        uint256 elapsed = block.timestamp - since;
        return (staked * aprBps * elapsed) / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
    }
}
