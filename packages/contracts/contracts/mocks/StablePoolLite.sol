// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title StablePoolLite
/// @notice Local stand-in for an Aerodrome sAMM pool: Solidly stable invariant
///         x³y + xy³ = k, 0.05% swap fee paid to LPs. Used for the NRX/USDC pool on the demo chain.
contract StablePoolLite is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MINIMUM_LIQUIDITY = 1e3;
    uint256 public constant FEE_BPS = 5; // 0.05%

    address public immutable token0;
    address public immutable token1;
    uint256 internal immutable decimals0;
    uint256 internal immutable decimals1;

    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public cumulativeVolume; // in token-normalised 1e18 units
    uint256 public cumulativeFees0;
    uint256 public cumulativeFees1;
    uint256 public createdAt;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Burn(address indexed sender, address indexed to, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Swap(address indexed sender, address indexed tokenIn, uint256 amountIn, uint256 amountOut, address indexed to);
    event Sync(uint256 reserve0, uint256 reserve1);

    error InsufficientOutput(uint256 out);
    error InsufficientLiquidityMinted();
    error InvalidToken();

    constructor(address tokenA, address tokenB) ERC20("Stable AMM NRX/USDC", "sAMM-NRX/USDC") {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        decimals0 = 10 ** IERC20Metadata(token0).decimals();
        decimals1 = 10 ** IERC20Metadata(token1).decimals();
        createdAt = block.timestamp;
    }

    function getReserves() external view returns (uint256, uint256, uint256) {
        return (reserve0, reserve1, block.timestamp);
    }

    // ---------------------------------------------------------------- liquidity

    function quoteAddLiquidity(uint256 amount0Desired, uint256 amount1Desired)
        public
        view
        returns (uint256 amount0, uint256 amount1, uint256 liquidity)
    {
        uint256 supply = totalSupply();
        if (supply == 0) {
            (amount0, amount1) = (amount0Desired, amount1Desired);
            liquidity = Math.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
        } else {
            uint256 amount1Optimal = (amount0Desired * reserve1) / reserve0;
            if (amount1Optimal <= amount1Desired) {
                (amount0, amount1) = (amount0Desired, amount1Optimal);
            } else {
                (amount0, amount1) = ((amount1Desired * reserve0) / reserve1, amount1Desired);
            }
            liquidity = Math.min((amount0 * supply) / reserve0, (amount1 * supply) / reserve1);
        }
    }

    function addLiquidity(uint256 amount0Desired, uint256 amount1Desired, uint256 minLiquidity, address to)
        external
        nonReentrant
        returns (uint256 liquidity)
    {
        uint256 amount0;
        uint256 amount1;
        (amount0, amount1, liquidity) = quoteAddLiquidity(amount0Desired, amount1Desired);
        if (liquidity == 0 || liquidity < minLiquidity) revert InsufficientLiquidityMinted();
        if (totalSupply() == 0) _mint(address(0xdead), MINIMUM_LIQUIDITY);
        IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0);
        IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1);
        _mint(to, liquidity);
        _sync();
        emit Mint(msg.sender, amount0, amount1, liquidity);
    }

    function removeLiquidity(uint256 liquidity, uint256 min0, uint256 min1, address to)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        uint256 supply = totalSupply();
        amount0 = (liquidity * reserve0) / supply;
        amount1 = (liquidity * reserve1) / supply;
        require(amount0 >= min0 && amount1 >= min1, "slippage");
        _burn(msg.sender, liquidity);
        IERC20(token0).safeTransfer(to, amount0);
        IERC20(token1).safeTransfer(to, amount1);
        _sync();
        emit Burn(msg.sender, to, amount0, amount1, liquidity);
    }

    // ---------------------------------------------------------------- swaps

    function getAmountOut(uint256 amountIn, address tokenIn) public view returns (uint256) {
        if (tokenIn != token0 && tokenIn != token1) revert InvalidToken();
        amountIn -= (amountIn * FEE_BPS) / 10_000;
        return _getAmountOut(amountIn, tokenIn, reserve0, reserve1);
    }

    function swap(address tokenIn, uint256 amountIn, uint256 minOut, address to)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        amountOut = getAmountOut(amountIn, tokenIn);
        if (amountOut < minOut || amountOut == 0) revert InsufficientOutput(amountOut);
        address tokenOut = tokenIn == token0 ? token1 : token0;
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(to, amountOut);
        uint256 fee = (amountIn * FEE_BPS) / 10_000;
        if (tokenIn == token0) {
            cumulativeFees0 += fee;
            cumulativeVolume += (amountIn * 1e18) / decimals0;
        } else {
            cumulativeFees1 += fee;
            cumulativeVolume += (amountIn * 1e18) / decimals1;
        }
        _sync();
        emit Swap(msg.sender, tokenIn, amountIn, amountOut, to);
    }

    /// @notice Marginal price of token0 in token1 (1e18 scale), for the peg display.
    function spotPrice0() external view returns (uint256) {
        if (reserve0 == 0) return 0;
        uint256 probe = decimals0 / 100; // 0.01 token0
        uint256 out = _getAmountOut(probe, token0, reserve0, reserve1);
        return (out * 1e18 * decimals0) / (probe * decimals1);
    }

    function _sync() internal {
        reserve0 = IERC20(token0).balanceOf(address(this));
        reserve1 = IERC20(token1).balanceOf(address(this));
        emit Sync(reserve0, reserve1);
    }

    // ---------------------------------------------------------------- Solidly stable maths

    function _k(uint256 x, uint256 y) internal view returns (uint256) {
        uint256 _x = (x * 1e18) / decimals0;
        uint256 _y = (y * 1e18) / decimals1;
        uint256 _a = (_x * _y) / 1e18;
        uint256 _b = ((_x * _x) / 1e18 + (_y * _y) / 1e18);
        return (_a * _b) / 1e18;
    }

    function _f(uint256 x0, uint256 y) internal pure returns (uint256) {
        uint256 _a = (x0 * y) / 1e18;
        uint256 _b = ((x0 * x0) / 1e18 + (y * y) / 1e18);
        return (_a * _b) / 1e18;
    }

    function _d(uint256 x0, uint256 y) internal pure returns (uint256) {
        return (3 * x0 * ((y * y) / 1e18)) / 1e18 + ((((x0 * x0) / 1e18) * x0) / 1e18);
    }

    function _getY(uint256 x0, uint256 xy, uint256 y) internal pure returns (uint256) {
        for (uint256 i = 0; i < 255; i++) {
            uint256 k = _f(x0, y);
            if (k < xy) {
                uint256 dy = ((xy - k) * 1e18) / _d(x0, y);
                if (dy == 0) {
                    if (k == xy) return y;
                    if (_f(x0, y + 1) > xy) return y + 1;
                    dy = 1;
                }
                y = y + dy;
            } else {
                uint256 dy = ((k - xy) * 1e18) / _d(x0, y);
                if (dy == 0) {
                    if (k == xy || _f(x0, y - 1) < xy) return y;
                    dy = 1;
                }
                y = y - dy;
            }
        }
        revert("!y");
    }

    function _getAmountOut(uint256 amountIn, address tokenIn, uint256 r0, uint256 r1) internal view returns (uint256) {
        if (r0 == 0 || r1 == 0) return 0;
        uint256 xy = _k(r0, r1);
        r0 = (r0 * 1e18) / decimals0;
        r1 = (r1 * 1e18) / decimals1;
        (uint256 reserveA, uint256 reserveB) = tokenIn == token0 ? (r0, r1) : (r1, r0);
        amountIn = tokenIn == token0 ? (amountIn * 1e18) / decimals0 : (amountIn * 1e18) / decimals1;
        uint256 y = reserveB - _getY(amountIn + reserveA, xy, reserveB);
        return (y * (tokenIn == token0 ? decimals1 : decimals0)) / 1e18;
    }
}
