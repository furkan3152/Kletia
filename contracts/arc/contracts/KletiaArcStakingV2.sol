// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice New-deployment staking with an APR time integral and user checkpoints.
contract KletiaArcStakingV2 is ERC2771Context {
    address public owner;

    uint256 public aprBps;

    uint256 public cooldownPeriod;

    uint256 public totalStaked;

    uint256 public rewardPoolBalance;

    uint256 private constant BPS_DENOMINATOR = 10000;
    uint256 private constant SECONDS_PER_YEAR = 31536000;
    uint256 private constant MAX_APR_BPS = 3000;
    uint256 private constant MIN_STAKE = 1;
    uint256 private constant REWARD_INDEX_SCALE = 1e27;

    uint256 public globalRewardIndex;
    uint256 public lastRewardAccrualTimestamp;
    mapping(address => uint256) public rewardIndexCheckpoint;

    struct StakerInfo {
        uint256 stakedAmount;
        uint256 stakingTimestamp;
        uint256 accruedRewards;
        uint256 pendingUnstake;
        uint256 unstakeRequestTime;
    }

    mapping(address => StakerInfo) public stakers;

    bool private _locked;

    modifier nonReentrant() {
        require(!_locked, "KletiaArcStaking: reentrant call");
        _locked = true;
        _;
        _locked = false;
    }

    event Staked(address indexed user, uint256 amount, uint256 totalUserStake);
    event UnstakeRequested(
        address indexed user,
        uint256 amount,
        uint256 claimableAfter
    );
    event Unstaked(address indexed user, uint256 amount);
    event RewardsClaimed(address indexed user, uint256 amount);
    event APRUpdated(uint256 oldAPR, uint256 newAPR);
    event RewardsFunded(
        address indexed funder,
        uint256 amount,
        uint256 newPoolBalance
    );
    event CooldownUpdated(uint256 oldCooldown, uint256 newCooldown);
    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    modifier onlyOwner() {
        require(
            _msgSender() == owner,
            "KletiaArcStaking: caller is not the owner"
        );
        _;
    }

    constructor(
        address trustedForwarder,
        uint256 _aprBps,
        uint256 _cooldownPeriod
    ) ERC2771Context(trustedForwarder) {
        require(_aprBps <= MAX_APR_BPS, "KletiaArcStaking: APR too high");
        require(_cooldownPeriod > 0, "KletiaArcStaking: cooldown must be > 0");

        owner = _msgSender();
        aprBps = _aprBps;
        cooldownPeriod = _cooldownPeriod;
        lastRewardAccrualTimestamp = block.timestamp;

        emit OwnershipTransferred(address(0), _msgSender());
        emit APRUpdated(0, _aprBps);
    }

    function stake() external payable nonReentrant {
        uint256 amount = msg.value;
        require(amount >= MIN_STAKE, "KletiaArcStaking: amount too small");

        StakerInfo storage s = stakers[_msgSender()];
        _checkpoint(_msgSender());

        s.stakedAmount += amount;
        s.stakingTimestamp = block.timestamp;
        totalStaked += amount;

        emit Staked(_msgSender(), amount, s.stakedAmount);
    }

    function unstake(uint256 amount) external nonReentrant {
        StakerInfo storage s = stakers[_msgSender()];

        require(amount > 0, "KletiaArcStaking: amount must be > 0");
        require(
            s.stakedAmount >= amount,
            "KletiaArcStaking: insufficient staked balance"
        );
        require(
            s.pendingUnstake == 0,
            "KletiaArcStaking: existing unstake pending"
        );

        _checkpoint(_msgSender());

        s.stakedAmount -= amount;
        s.stakingTimestamp = block.timestamp;
        s.pendingUnstake = amount;
        s.unstakeRequestTime = block.timestamp;
        totalStaked -= amount;

        emit UnstakeRequested(
            _msgSender(),
            amount,
            block.timestamp + cooldownPeriod
        );
    }

    function claimUnstaked() external nonReentrant {
        StakerInfo storage s = stakers[_msgSender()];

        require(s.pendingUnstake > 0, "KletiaArcStaking: no pending unstake");
        require(
            block.timestamp >= s.unstakeRequestTime + cooldownPeriod,
            "KletiaArcStaking: cooldown not elapsed"
        );

        uint256 payout = s.pendingUnstake;

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

    function claimRewards() external nonReentrant {
        StakerInfo storage s = stakers[_msgSender()];
        _checkpoint(_msgSender());
        uint256 rewards = s.accruedRewards;

        require(rewards > 0, "KletiaArcStaking: no rewards to claim");
        require(
            rewardPoolBalance >= rewards,
            "KletiaArcStaking: insufficient reward pool"
        );

        s.accruedRewards = 0;
        rewardPoolBalance -= rewards;

        (bool success, ) = payable(_msgSender()).call{value: rewards}("");
        require(success, "KletiaArcStaking: USDC native transfer failed");

        emit RewardsClaimed(_msgSender(), rewards);
    }

    function setAPR(uint256 newAprBps) external onlyOwner {
        require(newAprBps <= MAX_APR_BPS, "KletiaArcStaking: APR too high");
        _accrueGlobal();
        uint256 oldApr = aprBps;
        aprBps = newAprBps;
        emit APRUpdated(oldApr, newAprBps);
    }

    function setCooldownPeriod(uint256 newCooldown) external onlyOwner {
        require(newCooldown > 0, "KletiaArcStaking: cooldown must be > 0");
        uint256 oldCooldown = cooldownPeriod;
        cooldownPeriod = newCooldown;
        emit CooldownUpdated(oldCooldown, newCooldown);
    }

    function fundRewards() external payable onlyOwner {
        require(msg.value > 0, "KletiaArcStaking: amount must be > 0");
        rewardPoolBalance += msg.value;
        emit RewardsFunded(_msgSender(), msg.value, rewardPoolBalance);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "KletiaArcStaking: invalid new owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function pendingRewards(address user) external view returns (uint256) {
        return _pendingRewards(user);
    }

    function getStakerInfo(
        address user
    )
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

        accruedRewards = _pendingRewards(user);

        if (s.pendingUnstake > 0) {
            uint256 unlockTime = s.unstakeRequestTime + cooldownPeriod;
            cooldownRemaining =
                block.timestamp >= unlockTime
                    ? 0
                    : unlockTime - block.timestamp;
        }
    }

    function contractBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function _previewRewardIndex() internal view returns (uint256) {
        return globalRewardIndex +
            Math.mulDiv(aprBps * (block.timestamp - lastRewardAccrualTimestamp), REWARD_INDEX_SCALE,
                BPS_DENOMINATOR * SECONDS_PER_YEAR);
    }

    function _accrueGlobal() internal {
        globalRewardIndex = _previewRewardIndex();
        lastRewardAccrualTimestamp = block.timestamp;
    }

    function _pendingRewards(address user) internal view returns (uint256) {
        StakerInfo storage s = stakers[user];
        return s.accruedRewards +
            Math.mulDiv(s.stakedAmount, _previewRewardIndex() - rewardIndexCheckpoint[user], REWARD_INDEX_SCALE);
    }

    function _checkpoint(address user) internal {
        _accrueGlobal();
        StakerInfo storage s = stakers[user];
        s.accruedRewards +=
            Math.mulDiv(s.stakedAmount, globalRewardIndex - rewardIndexCheckpoint[user], REWARD_INDEX_SCALE);
        rewardIndexCheckpoint[user] = globalRewardIndex;
        s.stakingTimestamp = block.timestamp;
    }
}
