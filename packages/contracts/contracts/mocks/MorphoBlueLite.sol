// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

struct Market {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}

struct Position {
    uint256 supplyShares;
    uint128 borrowShares;
    uint128 collateral;
}

interface IOracle {
    /// @notice Price of 1 collateral unit in loan units, scaled by 1e36 (Morpho convention).
    function price() external view returns (uint256);
}

interface IIrm {
    function borrowRateView(MarketParams memory params, Market memory market) external view returns (uint256);
}

/// @title MorphoBlueLite
/// @notice Local stand-in for Morpho Blue used by the demo chains. It keeps Morpho's market
///         id, share accounting (virtual shares), LLTV health check and liquidation incentive
///         maths so the dApp and MorphoLenderStrategy integrate against the same shapes.
/// @dev Not Morpho. Production deployments use the canonical Morpho Blue + Bundler3.
contract MorphoBlueLite {
    using SafeERC20 for IERC20;
    using Math for uint256;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant ORACLE_PRICE_SCALE = 1e36;
    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;
    uint256 internal constant MAX_LIF = 1.15e18;
    uint256 internal constant LIF_CURSOR = 0.3e18;

    mapping(bytes32 => Market) public market;
    mapping(bytes32 => MarketParams) public idToMarketParams;
    mapping(bytes32 => mapping(address => Position)) public position;
    mapping(address => mapping(address => bool)) public isAuthorized;
    bytes32[] public marketIds;

    event CreateMarket(bytes32 indexed id, MarketParams params);
    event Supply(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);
    event Withdraw(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares);
    event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares);
    event Repay(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);
    event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets);
    event WithdrawCollateral(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets);
    event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 seizedAssets, uint256 badDebtAssets);
    event AccrueInterest(bytes32 indexed id, uint256 prevBorrowRate, uint256 interest);

    error MarketExists();
    error MarketNotCreated();
    error Unauthorized();
    error InsufficientCollateral();
    error InsufficientLiquidity();
    error HealthyPosition();
    error ZeroAssets();

    function id(MarketParams memory p) public pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    function marketCount() external view returns (uint256) {
        return marketIds.length;
    }

    function createMarket(MarketParams memory p) external {
        bytes32 mid = id(p);
        if (market[mid].lastUpdate != 0) revert MarketExists();
        market[mid].lastUpdate = uint128(block.timestamp);
        idToMarketParams[mid] = p;
        marketIds.push(mid);
        emit CreateMarket(mid, p);
    }

    function setAuthorization(address authorized, bool status) external {
        isAuthorized[msg.sender][authorized] = status;
    }

    // ---------------------------------------------------------------- lending

    function supply(MarketParams memory p, uint256 assets, address onBehalf) external returns (uint256 shares) {
        bytes32 mid = _accrue(p);
        if (assets == 0) revert ZeroAssets();
        Market storage m = market[mid];
        shares = _toSharesDown(assets, m.totalSupplyAssets, m.totalSupplyShares);
        position[mid][onBehalf].supplyShares += shares;
        m.totalSupplyShares += uint128(shares);
        m.totalSupplyAssets += uint128(assets);
        IERC20(p.loanToken).safeTransferFrom(msg.sender, address(this), assets);
        emit Supply(mid, msg.sender, onBehalf, assets, shares);
    }

    function withdraw(MarketParams memory p, uint256 assets, address onBehalf, address receiver)
        external
        returns (uint256 shares)
    {
        bytes32 mid = _accrue(p);
        _checkAuth(onBehalf);
        Market storage m = market[mid];
        shares = _toSharesUp(assets, m.totalSupplyAssets, m.totalSupplyShares);
        position[mid][onBehalf].supplyShares -= shares;
        m.totalSupplyShares -= uint128(shares);
        m.totalSupplyAssets -= uint128(assets);
        if (m.totalBorrowAssets > m.totalSupplyAssets) revert InsufficientLiquidity();
        IERC20(p.loanToken).safeTransfer(receiver, assets);
        emit Withdraw(mid, msg.sender, onBehalf, receiver, assets, shares);
    }

    function borrow(MarketParams memory p, uint256 assets, address onBehalf, address receiver)
        public
        returns (uint256 shares)
    {
        bytes32 mid = _accrue(p);
        _checkAuth(onBehalf);
        if (assets == 0) revert ZeroAssets();
        Market storage m = market[mid];
        shares = _toSharesUp(assets, m.totalBorrowAssets, m.totalBorrowShares);
        position[mid][onBehalf].borrowShares += uint128(shares);
        m.totalBorrowShares += uint128(shares);
        m.totalBorrowAssets += uint128(assets);
        if (!_isHealthy(p, mid, onBehalf)) revert InsufficientCollateral();
        if (m.totalBorrowAssets > m.totalSupplyAssets) revert InsufficientLiquidity();
        IERC20(p.loanToken).safeTransfer(receiver, assets);
        emit Borrow(mid, msg.sender, onBehalf, receiver, assets, shares);
    }

    /// @notice Repay by assets, or pass assets = 0 and shares > 0 to close a position exactly.
    function repay(MarketParams memory p, uint256 assets, uint256 shares, address onBehalf)
        external
        returns (uint256, uint256)
    {
        bytes32 mid = _accrue(p);
        Market storage m = market[mid];
        if (assets > 0) shares = _toSharesDown(assets, m.totalBorrowAssets, m.totalBorrowShares);
        else assets = _toAssetsUp(shares, m.totalBorrowAssets, m.totalBorrowShares);
        position[mid][onBehalf].borrowShares -= uint128(shares);
        m.totalBorrowShares -= uint128(shares);
        m.totalBorrowAssets = uint128(assets > m.totalBorrowAssets ? 0 : m.totalBorrowAssets - assets);
        IERC20(p.loanToken).safeTransferFrom(msg.sender, address(this), assets);
        emit Repay(mid, msg.sender, onBehalf, assets, shares);
        return (assets, shares);
    }

    function supplyCollateral(MarketParams memory p, uint256 assets, address onBehalf) public {
        bytes32 mid = id(p);
        if (market[mid].lastUpdate == 0) revert MarketNotCreated();
        if (assets == 0) revert ZeroAssets();
        position[mid][onBehalf].collateral += uint128(assets);
        IERC20(p.collateralToken).safeTransferFrom(msg.sender, address(this), assets);
        emit SupplyCollateral(mid, msg.sender, onBehalf, assets);
    }

    /// @notice Bundled action (what Bundler3 does in production): post collateral and borrow
    ///         in one transaction, so the dApp needs one wallet confirmation.
    function supplyCollateralAndBorrow(MarketParams memory p, uint256 collateral, uint256 borrowAssets, address receiver)
        external
    {
        if (collateral > 0) supplyCollateral(p, collateral, msg.sender);
        if (borrowAssets > 0) borrow(p, borrowAssets, msg.sender, receiver);
    }

    function withdrawCollateral(MarketParams memory p, uint256 assets, address onBehalf, address receiver) external {
        bytes32 mid = _accrue(p);
        _checkAuth(onBehalf);
        position[mid][onBehalf].collateral -= uint128(assets);
        if (!_isHealthy(p, mid, onBehalf)) revert InsufficientCollateral();
        IERC20(p.collateralToken).safeTransfer(receiver, assets);
        emit WithdrawCollateral(mid, msg.sender, onBehalf, receiver, assets);
    }

    /// @notice Repay part of an unhealthy borrower's debt and seize collateral at the
    ///         Morpho liquidation incentive factor.
    function liquidate(MarketParams memory p, address borrower, uint256 seizedAssets)
        external
        returns (uint256 seized, uint256 repaid)
    {
        bytes32 mid = _accrue(p);
        if (_isHealthy(p, mid, borrower)) revert HealthyPosition();
        Market storage m = market[mid];
        Position storage pos = position[mid][borrower];
        uint256 px = IOracle(p.oracle).price();
        uint256 lif = Math.min(MAX_LIF, WAD.mulDiv(WAD, WAD - LIF_CURSOR.mulDiv(WAD - p.lltv, WAD)));

        seized = Math.min(seizedAssets, pos.collateral);
        repaid = seized.mulDiv(px, ORACLE_PRICE_SCALE, Math.Rounding.Ceil).mulDiv(WAD, lif, Math.Rounding.Ceil);
        uint256 repaidShares = _toSharesDown(repaid, m.totalBorrowAssets, m.totalBorrowShares);
        if (repaidShares > pos.borrowShares) {
            repaidShares = pos.borrowShares;
            repaid = _toAssetsUp(repaidShares, m.totalBorrowAssets, m.totalBorrowShares);
        }
        pos.borrowShares -= uint128(repaidShares);
        pos.collateral -= uint128(seized);
        m.totalBorrowShares -= uint128(repaidShares);
        m.totalBorrowAssets = uint128(repaid > m.totalBorrowAssets ? 0 : m.totalBorrowAssets - repaid);

        uint256 badDebt;
        if (pos.collateral == 0 && pos.borrowShares > 0) {
            // Realise bad debt against suppliers, as Morpho does.
            uint256 badShares = pos.borrowShares;
            badDebt = Math.min(m.totalBorrowAssets, _toAssetsUp(badShares, m.totalBorrowAssets, m.totalBorrowShares));
            m.totalBorrowAssets -= uint128(badDebt);
            m.totalSupplyAssets -= uint128(badDebt);
            m.totalBorrowShares -= uint128(badShares);
            pos.borrowShares = 0;
        }

        IERC20(p.collateralToken).safeTransfer(msg.sender, seized);
        IERC20(p.loanToken).safeTransferFrom(msg.sender, address(this), repaid);
        emit Liquidate(mid, msg.sender, borrower, repaid, seized, badDebt);
    }

    function accrueInterest(MarketParams memory p) external {
        _accrue(p);
    }

    // ---------------------------------------------------------------- views

    function expectedMarket(MarketParams memory p) public view returns (Market memory m) {
        bytes32 mid = id(p);
        m = market[mid];
        uint256 elapsed = block.timestamp - m.lastUpdate;
        if (elapsed == 0 || m.totalBorrowAssets == 0 || p.irm == address(0)) return m;
        uint256 rate = IIrm(p.irm).borrowRateView(p, m);
        uint256 interest = uint256(m.totalBorrowAssets).mulDiv(_wTaylor(rate, elapsed), WAD);
        m.totalBorrowAssets += uint128(interest);
        m.totalSupplyAssets += uint128(interest);
        m.lastUpdate = uint128(block.timestamp);
    }

    function expectedSupplyAssets(MarketParams memory p, address user) external view returns (uint256) {
        Market memory m = expectedMarket(p);
        return _toAssetsDown(position[id(p)][user].supplyShares, m.totalSupplyAssets, m.totalSupplyShares);
    }

    function expectedBorrowAssets(MarketParams memory p, address user) public view returns (uint256) {
        Market memory m = expectedMarket(p);
        return _toAssetsUp(position[id(p)][user].borrowShares, m.totalBorrowAssets, m.totalBorrowShares);
    }

    /// @notice Health factor in WAD: (collateral value × LLTV) / debt. type(uint256).max with no debt.
    function healthFactor(MarketParams memory p, address user) external view returns (uint256) {
        uint256 debt = expectedBorrowAssets(p, user);
        if (debt == 0) return type(uint256).max;
        uint256 maxBorrow = uint256(position[id(p)][user].collateral).mulDiv(IOracle(p.oracle).price(), ORACLE_PRICE_SCALE)
            .mulDiv(p.lltv, WAD);
        return maxBorrow.mulDiv(WAD, debt);
    }

    function borrowRate(MarketParams memory p) external view returns (uint256) {
        if (p.irm == address(0)) return 0;
        return IIrm(p.irm).borrowRateView(p, expectedMarket(p));
    }

    function liquidity(MarketParams memory p) external view returns (uint256) {
        Market memory m = expectedMarket(p);
        return m.totalSupplyAssets - m.totalBorrowAssets;
    }

    // ---------------------------------------------------------------- internals

    function _accrue(MarketParams memory p) internal returns (bytes32 mid) {
        mid = id(p);
        Market storage m = market[mid];
        if (m.lastUpdate == 0) revert MarketNotCreated();
        uint256 elapsed = block.timestamp - m.lastUpdate;
        if (elapsed == 0) return mid;
        if (p.irm != address(0) && m.totalBorrowAssets > 0) {
            uint256 rate = IIrm(p.irm).borrowRateView(p, m);
            uint256 interest = uint256(m.totalBorrowAssets).mulDiv(_wTaylor(rate, elapsed), WAD);
            m.totalBorrowAssets += uint128(interest);
            m.totalSupplyAssets += uint128(interest);
            emit AccrueInterest(mid, rate, interest);
        }
        m.lastUpdate = uint128(block.timestamp);
    }

    function _isHealthy(MarketParams memory p, bytes32 mid, address user) internal view returns (bool) {
        Position memory pos = position[mid][user];
        if (pos.borrowShares == 0) return true;
        Market memory m = market[mid];
        uint256 debt = _toAssetsUp(pos.borrowShares, m.totalBorrowAssets, m.totalBorrowShares);
        uint256 maxBorrow =
            uint256(pos.collateral).mulDiv(IOracle(p.oracle).price(), ORACLE_PRICE_SCALE).mulDiv(p.lltv, WAD);
        return maxBorrow >= debt;
    }

    function _checkAuth(address onBehalf) internal view {
        if (msg.sender != onBehalf && !isAuthorized[onBehalf][msg.sender]) revert Unauthorized();
    }

    /// @dev Morpho's three-term Taylor expansion of e^(rt) - 1.
    function _wTaylor(uint256 x, uint256 n) internal pure returns (uint256) {
        uint256 first = x * n;
        uint256 second = first.mulDiv(first, 2 * WAD);
        uint256 third = second.mulDiv(first, 3 * WAD);
        return first + second + third;
    }

    function _toSharesDown(uint256 a, uint256 ta, uint256 ts) internal pure returns (uint256) {
        return a.mulDiv(ts + VIRTUAL_SHARES, ta + VIRTUAL_ASSETS);
    }

    function _toSharesUp(uint256 a, uint256 ta, uint256 ts) internal pure returns (uint256) {
        return a.mulDiv(ts + VIRTUAL_SHARES, ta + VIRTUAL_ASSETS, Math.Rounding.Ceil);
    }

    function _toAssetsDown(uint256 s, uint256 ta, uint256 ts) internal pure returns (uint256) {
        return s.mulDiv(ta + VIRTUAL_ASSETS, ts + VIRTUAL_SHARES);
    }

    function _toAssetsUp(uint256 s, uint256 ta, uint256 ts) internal pure returns (uint256) {
        return s.mulDiv(ta + VIRTUAL_ASSETS, ts + VIRTUAL_SHARES, Math.Rounding.Ceil);
    }
}

/// @notice Kinked linear rate model: 2% at 0% utilisation, 8% at the 90% kink, 60% at 100%.
contract KinkIrm is IIrm {
    uint256 internal constant WAD = 1e18;
    uint256 public constant BASE = 0.02e18;
    uint256 public constant SLOPE1 = 0.06e18;
    uint256 public constant SLOPE2 = 0.52e18;
    uint256 public constant KINK = 0.9e18;

    function borrowRateView(MarketParams memory, Market memory m) public pure returns (uint256) {
        uint256 util = m.totalSupplyAssets == 0 ? 0 : (uint256(m.totalBorrowAssets) * WAD) / m.totalSupplyAssets;
        uint256 apr;
        if (util <= KINK) apr = BASE + (SLOPE1 * util) / KINK;
        else apr = BASE + SLOPE1 + (SLOPE2 * (util - KINK)) / (WAD - KINK);
        return apr / 365 days; // per-second rate
    }
}

/// @notice Settable oracle used on the demo chains (Chainlink feeds in production).
contract MockOracle is IOracle {
    uint256 public price;
    address public owner;
    event PriceUpdated(uint256 price);

    constructor(uint256 price_) {
        price = price_;
        owner = msg.sender;
    }

    function setPrice(uint256 price_) external {
        require(msg.sender == owner, "owner");
        price = price_;
        emit PriceUpdated(price_);
    }
}
