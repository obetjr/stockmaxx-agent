// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Mock reference-price oracle for the Base Sepolia demo.
/// @dev Prices are USD values per whole token, scaled by 1e18 (so $1 = 1e18).
///      In a production version this role is filled by the Base Tokenized
///      Stocks API reference values; here the agent runner pushes simulated
///      fixture prices so the demo needs no paid data feed.
contract PriceOracle {
    address public owner;

    /// @notice USD price per whole token, scaled by 1e18.
    mapping(address => uint256) public priceUsd;

    event PriceSet(address indexed token, uint256 priceUsd);
    event OwnershipTransferred(address indexed from, address indexed to);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "PriceOracle: not owner");
        _;
    }

    function setPrice(address token, uint256 price) external onlyOwner {
        require(price > 0, "PriceOracle: zero price");
        priceUsd[token] = price;
        emit PriceSet(token, price);
    }

    function getPrice(address token) external view returns (uint256) {
        uint256 p = priceUsd[token];
        require(p > 0, "PriceOracle: no price");
        return p;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "PriceOracle: zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
