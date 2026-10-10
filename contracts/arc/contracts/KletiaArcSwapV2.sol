// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice New-deployment swap with user-bound minimum output and expiry.
/// @dev The immutable legacy pool remains a separate deployment and is not upgraded.
contract KletiaArcSwapV2 is ERC2771Context, ERC20, ReentrancyGuard {
    using Math for uint256;

    function _msgSender()
        internal
        view
        virtual
        override(Context, ERC2771Context)
        returns (address)
    {
        return ERC2771Context._msgSender();
    }

    function _msgData()
        internal
        view
        virtual
        override(Context, ERC2771Context)
        returns (bytes calldata)
    {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength()
        internal
        view
        virtual
        override(Context, ERC2771Context)
        returns (uint256)
    {
        return ERC2771Context._contextSuffixLength();
    }

    IERC20 public immutable token;

    uint256 public reserveUSDC;
    uint256 public reserveToken;

    uint32 public blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    error InvalidMinimumOutput();
    error SwapExpired(uint256 deadline);
    error InsufficientSwapOutput(uint256 minimum, uint256 actual);
    error UnsupportedTokenBehavior(uint256 expected, uint256 actual);

    modifier validSwapBounds(uint256 minAmountOut, uint256 deadline) {
        if (minAmountOut == 0) revert InvalidMinimumOutput();
        if (block.timestamp > deadline) revert SwapExpired(deadline);
        _;
    }

    event Swapped(
        address indexed user,
        address indexed fromToken,
        address indexed toToken,
        uint256 amountIn,
        uint256 amountOut
    );
    event LiquidityAdded(
        address indexed provider,
        uint256 usdcAmount,
        uint256 tokenAmount,
        uint256 lpMinted
    );
    event LiquidityRemoved(
        address indexed provider,
        uint256 usdcAmount,
        uint256 tokenAmount,
        uint256 lpBurned
    );

    constructor(
        address trustedForwarder,
        address _token
    )
        ERC20("Kletia Arc LP Token V2", "KLET-USDC-LP-V2")
        ERC2771Context(trustedForwarder)
    {
        require(_token != address(0), "Invalid token address");
        token = IERC20(_token);
    }

    receive() external payable {}

    function usdcReserve() external view returns (uint256) {
        return reserveUSDC;
    }

    function tokenReserve() external view returns (uint256) {
        return reserveToken;
    }

    function consultKletPrice() external view returns (uint256) {
        if (reserveToken == 0) return 0;
        return (reserveUSDC * 1e18) / reserveToken;
    }

    function currentCumulativePrices()
        public
        view
        returns (
            uint256 price0Cumulative,
            uint256 price1Cumulative,
            uint32 blockTimestamp
        )
    {
        price0Cumulative = price0CumulativeLast;
        price1Cumulative = price1CumulativeLast;
        blockTimestamp = uint32(block.timestamp % 2 ** 32);
        uint32 timeElapsed;
        unchecked {
            timeElapsed = blockTimestamp - blockTimestampLast;
        }
        if (timeElapsed > 0 && reserveUSDC != 0 && reserveToken != 0) {
            unchecked {
                price0Cumulative +=
                    ((reserveUSDC * 1e18) / reserveToken) * timeElapsed;
                price1Cumulative +=
                    ((reserveToken * 1e18) / reserveUSDC) * timeElapsed;
            }
        }
    }

    function _update(uint256 balanceUSDC, uint256 balanceToken) private {
        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        uint32 timeElapsed;
        unchecked {
            timeElapsed = blockTimestamp - blockTimestampLast;
        }
        if (timeElapsed > 0 && reserveUSDC != 0 && reserveToken != 0) {
            unchecked {
                price0CumulativeLast +=
                    ((reserveUSDC * 1e18) / reserveToken) * timeElapsed;
                price1CumulativeLast +=
                    ((reserveToken * 1e18) / reserveUSDC) * timeElapsed;
            }
        }
        reserveUSDC = balanceUSDC;
        reserveToken = balanceToken;
        blockTimestampLast = blockTimestamp;
    }

    function addLiquidity(
        uint256 maxTokenAmount
    )
        external
        payable
        nonReentrant
        returns (uint256 tokenAmount, uint256 lpMinted)
    {
        uint256 usdcAmount = msg.value;
        require(usdcAmount > 0, "Zero USDC added");
        require(maxTokenAmount > 0, "Zero token added");

        if (totalSupply() == 0) {
            tokenAmount = maxTokenAmount;
            lpMinted = Math.sqrt(usdcAmount * tokenAmount);
            require(lpMinted > 1000, "Zero LP minted");
            _mint(address(0xdead), 1000);
            lpMinted -= 1000;
        } else {
            uint256 tokenOptimal = (usdcAmount * reserveToken) / reserveUSDC;
            require(tokenOptimal <= maxTokenAmount, "Too much token required");
            tokenAmount = tokenOptimal;
            lpMinted = Math.min(
                (usdcAmount * totalSupply()) / reserveUSDC,
                (tokenAmount * totalSupply()) / reserveToken
            );
        }

        uint256 tokenBalanceBefore = token.balanceOf(address(this));
        require(
            token.transferFrom(_msgSender(), address(this), tokenAmount),
            "Token transfer failed"
        );
        _requireTokenDelta(address(this), tokenBalanceBefore, tokenAmount);

        _mint(_msgSender(), lpMinted);

        _update(address(this).balance, token.balanceOf(address(this)));

        emit LiquidityAdded(_msgSender(), usdcAmount, tokenAmount, lpMinted);
    }

    function removeLiquidity(
        uint256 lpAmount
    ) external nonReentrant returns (uint256 usdcAmount, uint256 tokenAmount) {
        require(lpAmount > 0, "Zero LP burned");
        require(balanceOf(_msgSender()) >= lpAmount, "Insufficient LP balance");

        usdcAmount = (lpAmount * reserveUSDC) / totalSupply();
        tokenAmount = (lpAmount * reserveToken) / totalSupply();

        _burn(_msgSender(), lpAmount);

        (bool success, ) = payable(_msgSender()).call{value: usdcAmount}("");
        require(success, "USDC transfer failed");

        _transferTokenExact(_msgSender(), tokenAmount);

        _update(address(this).balance, token.balanceOf(address(this)));

        emit LiquidityRemoved(_msgSender(), usdcAmount, tokenAmount, lpAmount);
    }

    function swapUSDCForToken(uint256 minAmountOut, uint256 deadline)
        external
        payable
        nonReentrant
        validSwapBounds(minAmountOut, deadline)
        returns (uint256 tokenAmount)
    {
        uint256 usdcAmount = msg.value;
        require(usdcAmount > 0, "Zero USDC input");

        uint256 usdcAmountWithFee = usdcAmount * 997;
        uint256 numerator = usdcAmountWithFee * reserveToken;
        uint256 denominator = (reserveUSDC * 1000) + usdcAmountWithFee;
        tokenAmount = numerator / denominator;

        require(tokenAmount > 0, "Zero token output");
        if (tokenAmount < minAmountOut) revert InsufficientSwapOutput(minAmountOut, tokenAmount);
        _transferTokenExact(_msgSender(), tokenAmount);

        _update(address(this).balance, token.balanceOf(address(this)));

        emit Swapped(
            _msgSender(),
            address(0),
            address(token),
            usdcAmount,
            tokenAmount
        );
    }

    function swapTokenForUSDC(
        uint256 tokenAmount,
        uint256 minAmountOut,
        uint256 deadline
    ) external nonReentrant validSwapBounds(minAmountOut, deadline) returns (uint256 usdcAmount) {
        require(tokenAmount > 0, "Zero token input");

        uint256 tokenAmountWithFee = tokenAmount * 997;
        uint256 numerator = tokenAmountWithFee * reserveUSDC;
        uint256 denominator = (reserveToken * 1000) + tokenAmountWithFee;
        usdcAmount = numerator / denominator;

        require(usdcAmount > 0, "Zero USDC output");
        if (usdcAmount < minAmountOut) revert InsufficientSwapOutput(minAmountOut, usdcAmount);

        uint256 tokenBalanceBefore = token.balanceOf(address(this));
        require(
            token.transferFrom(_msgSender(), address(this), tokenAmount),
            "Token transfer failed"
        );
        _requireTokenDelta(address(this), tokenBalanceBefore, tokenAmount);

        (bool success, ) = payable(_msgSender()).call{value: usdcAmount}("");
        require(success, "USDC transfer failed");

        _update(address(this).balance, token.balanceOf(address(this)));

        emit Swapped(
            _msgSender(),
            address(token),
            address(0),
            tokenAmount,
            usdcAmount
        );
    }

    function previewSwapUSDCForToken(
        uint256 usdcAmount
    ) external view returns (uint256 tokenAmount) {
        if (reserveUSDC == 0 || reserveToken == 0) return 0;
        uint256 usdcAmountWithFee = usdcAmount * 997;
        uint256 numerator = usdcAmountWithFee * reserveToken;
        uint256 denominator = (reserveUSDC * 1000) + usdcAmountWithFee;
        return numerator / denominator;
    }

    function previewSwapTokenForUSDC(
        uint256 tokenAmount
    ) external view returns (uint256 usdcAmount) {
        if (reserveUSDC == 0 || reserveToken == 0) return 0;
        uint256 tokenAmountWithFee = tokenAmount * 997;
        uint256 numerator = tokenAmountWithFee * reserveUSDC;
        uint256 denominator = (reserveToken * 1000) + tokenAmountWithFee;
        return numerator / denominator;
    }

    function _transferTokenExact(address recipient, uint256 amount) internal {
        uint256 beforeBalance = token.balanceOf(recipient);
        require(token.transfer(recipient, amount), "Token transfer failed");
        _requireTokenDelta(recipient, beforeBalance, amount);
    }

    function _requireTokenDelta(address recipient, uint256 beforeBalance, uint256 amount) internal view {
        uint256 afterBalance = token.balanceOf(recipient);
        uint256 delta = afterBalance >= beforeBalance ? afterBalance - beforeBalance : 0;
        if (delta != amount) revert UnsupportedTokenBehavior(amount, delta);
    }
}
