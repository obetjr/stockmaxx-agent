// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Like} from "./MockToken.sol";
import {PriceOracle} from "./PriceOracle.sol";

/// @notice Simulated swap venue for the Base Sepolia demo.
/// @dev Holds inventory of the mock settlement token and mock stock tokens
///      and swaps between any two priced tokens at the oracle reference
///      price, with zero spread and zero slippage. This models the
///      execution leg only; it is not a real market and holds no real value.
contract MockExchange {
    PriceOracle public immutable oracle;

    event Swap(
        address indexed trader,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(address _oracle) {
        oracle = PriceOracle(_oracle);
    }

    /// @notice USD value (scaled 1e18) of `amount` base units of `token`.
    function valueUsd(address token, uint256 amount) public view returns (uint256) {
        uint256 price = oracle.getPrice(token);
        uint8 dec = IERC20Like(token).decimals();
        return (amount * price) / (10 ** uint256(dec));
    }

    /// @notice Base units of `token` worth `usdValue` (scaled 1e18).
    function amountForUsd(address token, uint256 usdValue) public view returns (uint256) {
        uint256 price = oracle.getPrice(token);
        uint8 dec = IERC20Like(token).decimals();
        return (usdValue * (10 ** uint256(dec))) / price;
    }

    /// @notice Swap `amountIn` of tokenIn for tokenOut at the oracle price.
    /// @dev Caller must have approved this contract for tokenIn. The exchange
    ///      must hold enough tokenOut inventory (seeded in the demo setup).
    function swap(address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256 amountOut) {
        require(amountIn > 0, "MockExchange: zero amount");
        uint256 usd = valueUsd(tokenIn, amountIn);
        amountOut = amountForUsd(tokenOut, usd);
        require(amountOut > 0, "MockExchange: dust output");

        require(IERC20Like(tokenIn).transferFrom(msg.sender, address(this), amountIn), "MockExchange: in");
        require(IERC20Like(tokenOut).transfer(msg.sender, amountOut), "MockExchange: out");

        emit Swap(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }
}
