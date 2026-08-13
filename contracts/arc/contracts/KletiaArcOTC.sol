// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import "./IERC20.sol";

contract KletiaArcOTC is ERC2771Context {
    struct Order {
        address maker;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        bool isActive;
    }

    uint256 public orderCount;
    mapping(uint256 => Order) public orders;

    event OrderCreated(
        uint256 indexed orderId,
        address indexed maker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut
    );
    event OrderFilled(
        uint256 indexed orderId,
        address indexed taker,
        uint256 amountOut
    );

    constructor(address trustedForwarder) ERC2771Context(trustedForwarder) {}

    function createOrder(
        address _tokenIn,
        address _tokenOut,
        uint256 _amountIn,
        uint256 _minAmountOut
    ) external returns (uint256) {
        require(_amountIn > 0, "Amount must be > 0");
        IERC20(_tokenIn).transferFrom(_msgSender(), address(this), _amountIn);

        orderCount++;
        orders[orderCount] = Order({
            maker: _msgSender(),
            tokenIn: _tokenIn,
            tokenOut: _tokenOut,
            amountIn: _amountIn,
            minAmountOut: _minAmountOut,
            isActive: true
        });

        emit OrderCreated(
            orderCount,
            _msgSender(),
            _tokenIn,
            _tokenOut,
            _amountIn,
            _minAmountOut
        );
        return orderCount;
    }

    function fillOrder(uint256 _orderId) external payable {
        Order storage order = orders[_orderId];
        require(order.isActive, "Order not active");

        if (order.tokenOut == address(0)) {
            require(
                msg.value >= order.minAmountOut,
                "Insufficient native value"
            );
            payable(order.maker).transfer(msg.value);
        } else {
            IERC20(order.tokenOut).transferFrom(
                _msgSender(),
                order.maker,
                order.minAmountOut
            );
        }

        IERC20(order.tokenIn).transfer(_msgSender(), order.amountIn);
        order.isActive = false;

        emit OrderFilled(_orderId, _msgSender(), order.minAmountOut);
    }

    function cancelOrder(uint256 _orderId) external {
        Order storage order = orders[_orderId];
        require(order.isActive, "Order not active");
        require(order.maker == _msgSender(), "Not your order");

        order.isActive = false;
        IERC20(order.tokenIn).transfer(_msgSender(), order.amountIn);
    }
}
