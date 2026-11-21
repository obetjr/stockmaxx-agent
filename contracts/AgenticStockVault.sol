// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Like} from "./MockToken.sol";
import {PriceOracle} from "./PriceOracle.sol";
import {MockExchange} from "./MockExchange.sol";

/// @title AgenticStockVault — a guardrailed vault for an autonomous stock agent
/// @notice Built for Base's Stocks Maxxing Season, Track 2: Agentic Stock Finance.
/// @dev The vault holds a settlement token plus a basket of (simulated)
///      tokenized stock tokens. A designated `agent` address may rebalance
///      the basket, but only inside hard on-chain guardrails:
///
///      1. Allowlist      — the agent can only trade tokens the owner listed.
///      2. Decision log   — every rebalance cycle must first be committed
///                          on-chain via `logDecision` (reason string + event).
///      3. Cycle interval — cycles cannot start more often than
///                          `minCycleInterval` seconds.
///      4. Trade cap      — a single trade may not exceed `maxTradeBps`
///                          basis points of the vault's current NAV.
///      5. Cycle window   — trades are only accepted within `cycleWindow`
///                          seconds after the cycle's decision was logged.
///
///      The owner keeps custody powers (deposit, withdraw, config). The
///      agent can never withdraw funds or change the guardrails.
contract AgenticStockVault {
    address public owner;
    address public agent;

    IERC20Like public immutable settlement;
    PriceOracle public immutable oracle;
    MockExchange public immutable exchange;

    // --- Guardrails -------------------------------------------------------
    uint256 public maxTradeBps = 2500; // 25% of NAV per single trade
    uint256 public minCycleInterval = 3600; // 1 hour between cycles
    uint256 public cycleWindow = 3600; // trades valid 1 hour after decision log

    // --- Basket -----------------------------------------------------------
    address[] public basket;
    mapping(address => bool) public allowlisted;

    // --- Cycle state ------------------------------------------------------
    uint256 public cycleCount;
    uint256 public lastCycleAt;
    uint256 public currentCycleId;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event AgentUpdated(address indexed oldAgent, address indexed newAgent);
    event GuardrailsUpdated(uint256 maxTradeBps, uint256 minCycleInterval, uint256 cycleWindow);
    event TokenAllowlisted(address indexed token, bool allowed);
    event DecisionLogged(uint256 indexed cycleId, address indexed agent, string reason, uint256 timestamp);
    event TradeExecuted(
        uint256 indexed cycleId,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 valueUsd
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Vault: not owner");
        _;
    }

    modifier onlyAgent() {
        require(msg.sender == agent, "Vault: not agent");
        _;
    }

    constructor(address _settlement, address _oracle, address _exchange, address _agent) {
        require(_settlement != address(0) && _oracle != address(0), "Vault: zero address");
        require(_exchange != address(0) && _agent != address(0), "Vault: zero address");
        owner = msg.sender;
        agent = _agent;
        settlement = IERC20Like(_settlement);
        oracle = PriceOracle(_oracle);
        exchange = MockExchange(_exchange);
    }

    // --- Owner: funds -----------------------------------------------------

    function deposit(uint256 amount) external onlyOwner {
        require(settlement.transferFrom(msg.sender, address(this), amount), "Vault: deposit");
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw settlement or any basket token. Owner only — the
    ///         agent has no path to move funds out of the vault.
    function withdraw(address token, uint256 amount) external onlyOwner {
        require(IERC20Like(token).transfer(msg.sender, amount), "Vault: withdraw");
        emit Withdrawn(msg.sender, amount);
    }

    // --- Owner: configuration ----------------------------------------------

    function setAgent(address newAgent) external onlyOwner {
        require(newAgent != address(0), "Vault: zero address");
        emit AgentUpdated(agent, newAgent);
        agent = newAgent;
    }

    function setGuardrails(uint256 _maxTradeBps, uint256 _minCycleInterval, uint256 _cycleWindow)
        external
        onlyOwner
    {
        require(_maxTradeBps > 0 && _maxTradeBps <= 10_000, "Vault: bad bps");
        maxTradeBps = _maxTradeBps;
        minCycleInterval = _minCycleInterval;
        cycleWindow = _cycleWindow;
        emit GuardrailsUpdated(_maxTradeBps, _minCycleInterval, _cycleWindow);
    }

    function setAllowlisted(address token, bool allowed) external onlyOwner {
        require(token != address(settlement), "Vault: settlement not a basket token");
        if (allowed && !allowlisted[token]) {
            basket.push(token);
        }
        allowlisted[token] = allowed;
        emit TokenAllowlisted(token, allowed);
    }

    function basketLength() external view returns (uint256) {
        return basket.length;
    }

    // --- Valuation ----------------------------------------------------------

    /// @notice USD value (scaled 1e18) of `amount` base units of `token`.
    function valueUsd(address token, uint256 amount) public view returns (uint256) {
        if (amount == 0) return 0;
        uint256 price = oracle.getPrice(token);
        uint8 dec = IERC20Like(token).decimals();
        return (amount * price) / (10 ** uint256(dec));
    }

    /// @notice Total net asset value of the vault in USD, scaled 1e18.
    function nav() public view returns (uint256 total) {
        total = valueUsd(address(settlement), settlement.balanceOf(address(this)));
        for (uint256 i = 0; i < basket.length; i++) {
            address token = basket[i];
            total += valueUsd(token, IERC20Like(token).balanceOf(address(this)));
        }
    }

    // --- Agent: rebalance cycle --------------------------------------------

    /// @notice Commit a rebalance decision on-chain before trading.
    /// @dev This is the transparency core of the design: anyone can audit
    ///      what the agent intended, when, and (via TradeExecuted) what it
    ///      actually did. Enforces the minimum interval between cycles.
    function logDecision(string calldata reason) external onlyAgent returns (uint256 cycleId) {
        require(block.timestamp >= lastCycleAt + minCycleInterval, "Vault: cycle too soon");
        cycleCount += 1;
        cycleId = cycleCount;
        currentCycleId = cycleId;
        lastCycleAt = block.timestamp;
        emit DecisionLogged(cycleId, msg.sender, reason, block.timestamp);
    }

    /// @notice Execute one swap inside the currently open cycle.
    /// @dev One side must be the settlement token, the other an allowlisted
    ///      basket token. The trade's USD value is capped at
    ///      `maxTradeBps` of NAV, and the cycle must still be in its window.
    function executeTrade(address tokenIn, address tokenOut, uint256 amountIn)
        external
        onlyAgent
        returns (uint256 amountOut)
    {
        require(currentCycleId > 0, "Vault: no cycle");
        require(block.timestamp <= lastCycleAt + cycleWindow, "Vault: cycle window closed");

        bool isBuy = tokenIn == address(settlement) && allowlisted[tokenOut];
        bool isSell = tokenOut == address(settlement) && allowlisted[tokenIn];
        require(isBuy || isSell, "Vault: pair not allowed");

        uint256 tradeValue = valueUsd(tokenIn, amountIn);
        uint256 cap = (nav() * maxTradeBps) / 10_000;
        require(tradeValue > 0 && tradeValue <= cap, "Vault: trade exceeds cap");

        require(IERC20Like(tokenIn).approve(address(exchange), amountIn), "Vault: approve");
        amountOut = exchange.swap(tokenIn, tokenOut, amountIn);

        emit TradeExecuted(currentCycleId, tokenIn, tokenOut, amountIn, amountOut, tradeValue);
    }
}
