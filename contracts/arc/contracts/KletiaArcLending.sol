// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IKletiaArcSwap {
    function usdcReserve() external view returns (uint256);
    function tokenReserve() external view returns (uint256);
    function currentCumulativePrices()
        external
        view
        returns (
            uint256 price0Cumulative,
            uint256 price1Cumulative,
            uint32 blockTimestamp
        );
    function consultKletPrice() external view returns (uint256);
}

contract KletiaArcLending is ERC2771Context, ReentrancyGuard {
    IERC20 public immutable kletToken;
    IKletiaArcSwap public swapPool;

    uint256 public constant RAY = 1e27;
    uint256 public constant WAD = 1e18;
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    uint256 public constant LTV_BIPS = 7000;
    uint256 public constant LIQ_THRESHOLD_BIPS = 8000;
    uint256 public constant LIQ_PENALTY_BIPS = 500;
    uint256 public constant BIPS_DENOMINATOR = 10000;

    uint256 public constant OPTIMAL_UTILIZATION = 0.8 * 1e27;
    uint256 public constant BASE_BORROW_RATE = 0;
    uint256 public constant RATE_SLOPE_1 = 0.04 * 1e27;
    uint256 public constant RATE_SLOPE_2 = 3.00 * 1e27;
    uint256 public constant RESERVE_FACTOR = 0.1 * 1e27;

    uint256 public liquidityIndex = RAY;
    uint256 public borrowIndex = RAY;
    uint256 public currentLiquidityRate;
    uint256 public currentBorrowRate;
    uint40 public lastUpdateTimestamp;

    uint256 public twapPrice;
    uint256 public lastPriceCumulative;
    uint32 public lastTwapTimestamp;

    mapping(address => uint256) public collateralBalance;
    mapping(address => uint256) public scaledSuppliedUSDC;
    mapping(address => uint256) public scaledBorrowedUSDC;

    uint256 public scaledTotalUSDCSupplied;
    uint256 public scaledTotalUSDCBorrowed;

    event CollateralAdded(address indexed user, uint256 amount);
    event CollateralRemoved(address indexed user, uint256 amount);
    event USDCBorrowed(address indexed user, uint256 amount);
    event USDCRepaid(address indexed user, uint256 amount);
    event Liquidated(
        address indexed liquidator,
        address indexed target,
        uint256 debtRepaid,
        uint256 collateralSeized
    );

    constructor(
        address trustedForwarder,
        address _kletToken,
        address _swapPool
    ) ERC2771Context(trustedForwarder) {
        kletToken = IERC20(_kletToken);
        swapPool = IKletiaArcSwap(_swapPool);
        lastUpdateTimestamp = uint40(block.timestamp);
    }

    receive() external payable {
        _updateState();
        _updateTWAP();
        uint256 amount = msg.value;
        uint256 scaledAmount = rayDiv(amount, liquidityIndex);
        scaledTotalUSDCSupplied += scaledAmount;
        scaledSuppliedUSDC[_msgSender()] += scaledAmount;
        _updateRates();
    }

    modifier updateStateAndRates() {
        _updateState();
        _updateTWAP();
        _;
        _updateRates();
    }

    function supplyUSDC() external payable nonReentrant updateStateAndRates {
        require(msg.value > 0, "KletiaArcLending: Zero supply");
        uint256 scaledAmount = rayDiv(msg.value, liquidityIndex);
        scaledTotalUSDCSupplied += scaledAmount;
        scaledSuppliedUSDC[_msgSender()] += scaledAmount;
    }

    function withdrawUSDC(
        uint256 amount
    ) external nonReentrant updateStateAndRates {
        require(amount > 0, "KletiaArcLending: Zero withdraw");
        address user = _msgSender();

        uint256 userBalance = rayMul(scaledSuppliedUSDC[user], liquidityIndex);
        require(
            userBalance >= amount,
            "KletiaArcLending: Insufficient supplied balance"
        );
        require(
            address(this).balance >= amount,
            "KletiaArcLending: Insufficient pool liquidity"
        );

        uint256 scaledAmount = rayDiv(amount, liquidityIndex);
        unchecked {
            scaledSuppliedUSDC[user] -= scaledAmount;
            scaledTotalUSDCSupplied -= scaledAmount;
        }

        (bool success, ) = payable(user).call{value: amount}("");
        require(success, "KletiaArcLending: Transfer failed");
    }

    function depositCollateral(uint256 amount) external nonReentrant {
        require(amount > 0, "KletiaArcLending: Zero deposit");
        address user = _msgSender();

        require(
            kletToken.transferFrom(user, address(this), amount),
            "KletiaArcLending: Transfer failed"
        );
        collateralBalance[user] += amount;

        emit CollateralAdded(user, amount);
    }

    function withdrawCollateral(
        uint256 amount
    ) external nonReentrant updateStateAndRates {
        address user = _msgSender();
        require(
            amount > 0 && amount <= collateralBalance[user],
            "KletiaArcLending: Invalid amount"
        );

        unchecked {
            collateralBalance[user] -= amount;
        }

        require(
            healthFactor(user) >= WAD,
            "KletiaArcLending: Health factor too low"
        );

        require(
            kletToken.transfer(user, amount),
            "KletiaArcLending: Transfer failed"
        );
        emit CollateralRemoved(user, amount);
    }

    function borrow(
        uint256 borrowAmount
    ) external nonReentrant updateStateAndRates {
        require(borrowAmount > 0, "KletiaArcLending: Zero borrow");
        address user = _msgSender();

        require(
            address(this).balance >= borrowAmount,
            "KletiaArcLending: Insufficient pool liquidity"
        );

        uint256 scaledAmount = rayDiv(borrowAmount, borrowIndex);
        scaledBorrowedUSDC[user] += scaledAmount;
        scaledTotalUSDCBorrowed += scaledAmount;

        uint256 maxBorrow = _getMaxBorrow(user);
        uint256 currentDebt = rayMul(scaledBorrowedUSDC[user], borrowIndex);
        require(
            currentDebt <= maxBorrow,
            "KletiaArcLending: Exceeds max borrow LTV"
        );

        (bool success, ) = payable(user).call{value: borrowAmount}("");
        require(success, "KletiaArcLending: USDC transfer failed");

        emit USDCBorrowed(user, borrowAmount);
    }

    function repay() external payable nonReentrant updateStateAndRates {
        uint256 repayAmount = msg.value;
        address user = _msgSender();
        require(repayAmount > 0, "KletiaArcLending: Zero repay");

        uint256 currentDebt = rayMul(scaledBorrowedUSDC[user], borrowIndex);

        if (repayAmount > currentDebt) {
            uint256 excess;
            unchecked {
                excess = repayAmount - currentDebt;
            }
            scaledBorrowedUSDC[user] = 0;
            unchecked {
                scaledTotalUSDCBorrowed -= rayDiv(currentDebt, borrowIndex);
            }

            (bool success, ) = payable(user).call{value: excess}("");
            require(success, "KletiaArcLending: Refund failed");
        } else {
            uint256 scaledAmount = rayDiv(repayAmount, borrowIndex);
            unchecked {
                scaledBorrowedUSDC[user] -= scaledAmount;
                scaledTotalUSDCBorrowed -= scaledAmount;
            }
        }

        emit USDCRepaid(user, repayAmount);
    }

    function liquidate(
        address target
    ) external payable nonReentrant updateStateAndRates {
        address liquidator = _msgSender();
        require(
            target != liquidator,
            "KletiaArcLending: Cannot liquidate self"
        );
        require(
            healthFactor(target) < WAD,
            "KletiaArcLending: Position is healthy"
        );

        uint256 currentDebt = rayMul(scaledBorrowedUSDC[target], borrowIndex);

        uint256 kletPrice = _getKletPrice();
        uint256 kletRequired = (currentDebt * WAD) / kletPrice;
        uint256 kletToSeize =
            kletRequired +
                ((kletRequired * LIQ_PENALTY_BIPS) / BIPS_DENOMINATOR);

        uint256 userCollateral = collateralBalance[target];
        uint256 debtToRepay = currentDebt;

        if (kletToSeize > userCollateral) {
            kletToSeize = userCollateral;
            uint256 penaltyFactor =
                WAD + (WAD * LIQ_PENALTY_BIPS) / BIPS_DENOMINATOR;
            debtToRepay = (userCollateral * kletPrice) / penaltyFactor;
        }

        require(
            msg.value >= debtToRepay,
            "KletiaArcLending: Insufficient repayment"
        );
        uint256 excess;
        unchecked {
            excess = msg.value - debtToRepay;
        }

        unchecked {
            scaledBorrowedUSDC[target] -= rayDiv(debtToRepay, borrowIndex);
            scaledTotalUSDCBorrowed -= rayDiv(debtToRepay, borrowIndex);
            collateralBalance[target] -= kletToSeize;
        }

        require(
            kletToken.transfer(liquidator, kletToSeize),
            "KletiaArcLending: Collateral transfer failed"
        );

        if (excess > 0) {
            (bool success, ) = payable(liquidator).call{value: excess}("");
            require(success, "KletiaArcLending: Refund failed");
        }

        emit Liquidated(liquidator, target, debtToRepay, kletToSeize);
    }

    function _updateState() internal {
        uint40 currentTimestamp = uint40(block.timestamp);
        if (currentTimestamp == lastUpdateTimestamp) return;

        if (scaledTotalUSDCBorrowed > 0) {
            uint256 timeDelta;
            unchecked {
                timeDelta = currentTimestamp - lastUpdateTimestamp;
            }

            uint256 cumulatedLiquidityInterest =
                RAY + ((currentLiquidityRate * timeDelta) / SECONDS_PER_YEAR);
            liquidityIndex = rayMul(liquidityIndex, cumulatedLiquidityInterest);

            uint256 ratePerSecond = currentBorrowRate / SECONDS_PER_YEAR;
            uint256 basePowerTwo = rayMul(ratePerSecond, ratePerSecond);
            uint256 secondTerm;
            unchecked {
                secondTerm = (timeDelta * (timeDelta - 1) * basePowerTwo) / 2;
            }
            uint256 cumulatedBorrowInterest =
                RAY + (ratePerSecond * timeDelta) + secondTerm;
            borrowIndex = rayMul(borrowIndex, cumulatedBorrowInterest);
        }

        lastUpdateTimestamp = currentTimestamp;
    }

    function _updateTWAP() internal {
        uint256 currentCumulative = 0;
        uint32 blockTimestamp = 0;

        try swapPool.currentCumulativePrices() returns (
            uint256 val0,
            uint256,
            uint32 ts
        ) {
            currentCumulative = val0;
            blockTimestamp = ts;
        } catch {
            return;
        }

        if (blockTimestamp == lastTwapTimestamp) return;

        if (lastTwapTimestamp != 0) {
            uint32 timeElapsed = blockTimestamp - lastTwapTimestamp;
            if (timeElapsed > 0) {
                twapPrice =
                    (currentCumulative - lastPriceCumulative) / timeElapsed;
            }
        }

        lastPriceCumulative = currentCumulative;
        lastTwapTimestamp = blockTimestamp;
    }

    function _updateRates() internal {
        uint256 totalDebt = rayMul(scaledTotalUSDCBorrowed, borrowIndex);
        uint256 totalLiquidity = address(this).balance;

        if (totalDebt == 0) {
            currentBorrowRate = BASE_BORROW_RATE;
            currentLiquidityRate = 0;
            return;
        }

        uint256 utilizationRate = rayDiv(totalDebt, totalDebt + totalLiquidity);

        if (utilizationRate <= OPTIMAL_UTILIZATION) {
            currentBorrowRate =
                BASE_BORROW_RATE +
                rayMul(
                    rayDiv(utilizationRate, OPTIMAL_UTILIZATION),
                    RATE_SLOPE_1
                );
        } else {
            uint256 excessUtilizationRate;
            unchecked {
                excessUtilizationRate = rayDiv(
                    utilizationRate - OPTIMAL_UTILIZATION,
                    RAY - OPTIMAL_UTILIZATION
                );
            }
            currentBorrowRate =
                BASE_BORROW_RATE +
                RATE_SLOPE_1 +
                rayMul(excessUtilizationRate, RATE_SLOPE_2);
        }

        currentLiquidityRate = rayMul(
            rayMul(currentBorrowRate, utilizationRate),
            RAY - RESERVE_FACTOR
        );
    }

    function _getKletPrice() public view returns (uint256) {
        require(twapPrice > 0, "KletiaArcLending: TWAP not initialized");
        return twapPrice;
    }

    function _getMaxBorrow(address user) public view returns (uint256) {
        uint256 colKlet = collateralBalance[user];
        if (colKlet == 0) return 0;
        uint256 kletPrice = _getKletPrice();
        uint256 colValueUSDC = (colKlet * kletPrice) / WAD;
        return (colValueUSDC * LTV_BIPS) / BIPS_DENOMINATOR;
    }

    function healthFactor(address user) public view returns (uint256) {
        uint256 currentDebt = rayMul(scaledBorrowedUSDC[user], borrowIndex);
        if (currentDebt == 0) return type(uint256).max;

        uint256 colKlet = collateralBalance[user];
        if (colKlet == 0) return 0;

        uint256 kletPrice = _getKletPrice();
        uint256 colValueUSDC = (colKlet * kletPrice) / WAD;

        uint256 thresholdLimit =
            (colValueUSDC * LIQ_THRESHOLD_BIPS) / BIPS_DENOMINATOR;
        return (thresholdLimit * WAD) / currentDebt;
    }

    function rayMul(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * b + (RAY / 2)) / RAY;
    }

    function rayDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * RAY + (b / 2)) / b;
    }

    function getSuppliedBalance(address user) external view returns (uint256) {
        return rayMul(scaledSuppliedUSDC[user], liquidityIndex);
    }

    function getBorrowedBalance(address user) external view returns (uint256) {
        return rayMul(scaledBorrowedUSDC[user], borrowIndex);
    }
}
