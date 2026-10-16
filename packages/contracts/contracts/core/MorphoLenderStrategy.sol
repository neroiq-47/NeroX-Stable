// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MorphoBlueLite, MarketParams} from "../mocks/MorphoBlueLite.sol";

/// @title MorphoLenderStrategy
/// @notice Supplies sNRX vault NRX as the lender in NeroX's own Morpho markets, so sNRX
///         income is borrower interest only — never reserve income from the PSM.
contract MorphoLenderStrategy is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");

    IERC20 public immutable asset;
    MorphoBlueLite public immutable morpho;
    address public vault;

    MarketParams[] internal _markets;
    uint256[] public weightsBps;

    event VaultSet(address vault);
    event MarketsSet(uint256 count);
    event Deployed(uint256 assets);
    event Freed(uint256 requested, uint256 freed);

    error OnlyVault();
    error BadWeights();

    constructor(address admin, IERC20 asset_, MorphoBlueLite morpho_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ALLOCATOR_ROLE, admin);
        asset = asset_;
        morpho = morpho_;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    function setVault(address vault_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(vault == address(0), "vault set");
        vault = vault_;
        emit VaultSet(vault_);
    }

    function setMarkets(MarketParams[] calldata markets_, uint256[] calldata weights) external onlyRole(ALLOCATOR_ROLE) {
        if (markets_.length != weights.length) revert BadWeights();
        uint256 sum;
        for (uint256 i; i < weights.length; ++i) sum += weights[i];
        if (sum != 10_000) revert BadWeights();
        delete _markets;
        for (uint256 i; i < markets_.length; ++i) _markets.push(markets_[i]);
        weightsBps = weights;
        emit MarketsSet(markets_.length);
    }

    function markets() external view returns (MarketParams[] memory) {
        return _markets;
    }

    /// @notice NRX supplied across markets, including accrued borrower interest.
    function totalAssets() public view returns (uint256 total) {
        for (uint256 i; i < _markets.length; ++i) total += morpho.expectedSupplyAssets(_markets[i], address(this));
    }

    /// @notice NRX that can be withdrawn right now (bounded by each market's free liquidity).
    function availableLiquidity() public view returns (uint256 total) {
        for (uint256 i; i < _markets.length; ++i) {
            total += Math.min(morpho.expectedSupplyAssets(_markets[i], address(this)), morpho.liquidity(_markets[i]));
        }
    }

    /// @notice Pull `amount` NRX from the vault and supply it by weight.
    function deploy(uint256 amount) external onlyVault {
        if (amount == 0 || _markets.length == 0) return;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        asset.forceApprove(address(morpho), amount);
        uint256 left = amount;
        for (uint256 i; i < _markets.length; ++i) {
            uint256 part = i == _markets.length - 1 ? left : (amount * weightsBps[i]) / 10_000;
            if (part == 0) continue;
            morpho.supply(_markets[i], part, address(this));
            left -= part;
        }
        emit Deployed(amount);
    }

    /// @notice Withdraw up to `amount` NRX to the vault; returns what could be freed.
    function free(uint256 amount) external onlyVault returns (uint256 freed) {
        for (uint256 i; i < _markets.length && freed < amount; ++i) {
            uint256 avail =
                Math.min(morpho.expectedSupplyAssets(_markets[i], address(this)), morpho.liquidity(_markets[i]));
            uint256 take = Math.min(avail, amount - freed);
            if (take == 0) continue;
            morpho.withdraw(_markets[i], take, address(this), vault);
            freed += take;
        }
        emit Freed(amount, freed);
    }
}
