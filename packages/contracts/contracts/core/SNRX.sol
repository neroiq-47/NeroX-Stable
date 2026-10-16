// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MorphoLenderStrategy} from "./MorphoLenderStrategy.sol";

/// @title sNRX — NeroX savings vault (ERC-4626)
/// @notice Stake NRX, receive sNRX shares whose NRX value rises as borrowers pay interest.
///         Income comes from Morpho borrowers and an optional share of x402 fees —
///         never from the USDC reserves backing NRX. Returns vary and are not guaranteed.
/// @dev Virtual shares (decimals offset 6) protect against the first-depositor inflation
///      attack. A withdrawal queue covers the case where Morpho liquidity is thin.
contract SNRX is ERC4626, AccessControl, Pausable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    struct WithdrawalRequest {
        address owner;
        address receiver;
        uint128 shares;
        uint64 requestedAt;
        bool done;
    }

    MorphoLenderStrategy public strategy;
    /// @notice Share of deposits kept idle in the vault for instant withdrawals.
    uint256 public bufferBps = 1_000;
    uint256 public depositCap;

    WithdrawalRequest[] public requests;
    uint256 public nextRequestToProcess;
    uint256 public queuedShares;
    uint256 public totalFeeIncome;

    event StrategySet(address strategy);
    event BufferSet(uint256 bps);
    event DepositCapSet(uint256 cap);
    event Rebalanced(uint256 idle, uint256 deployed);
    event WithdrawalRequested(uint256 indexed requestId, address indexed owner, address receiver, uint256 shares);
    event WithdrawalProcessed(uint256 indexed requestId, address indexed owner, uint256 shares, uint256 assets);
    event WithdrawalCancelled(uint256 indexed requestId, address indexed owner, uint256 shares);
    event FeeIncome(address indexed from, uint256 assets, bytes32 indexed source);

    error InsufficientLiquidity(uint256 available);
    error DepositCapExceeded(uint256 remaining);
    error NotRequestOwner();

    constructor(address admin, address guardian, IERC20 nrx, uint256 depositCap_)
        ERC20("NeroX Savings NRX", "sNRX")
        ERC4626(nrx)
    {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
        depositCap = depositCap_;
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    // ---------------------------------------------------------------- accounting

    function idle() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function totalAssets() public view override returns (uint256) {
        uint256 deployed = address(strategy) == address(0) ? 0 : strategy.totalAssets();
        return idle() + deployed;
    }

    /// @notice NRX that can leave the vault right now.
    function availableLiquidity() public view returns (uint256) {
        uint256 deployedLiquid = address(strategy) == address(0) ? 0 : strategy.availableLiquidity();
        return idle() + deployedLiquid;
    }

    /// @notice Price of one whole sNRX in NRX base units (6 decimals).
    function sharePrice() external view returns (uint256) {
        return convertToAssets(10 ** decimals());
    }

    function maxDeposit(address) public view override returns (uint256) {
        if (paused()) return 0;
        uint256 ta = totalAssets();
        return ta >= depositCap ? 0 : depositCap - ta;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return convertToShares(maxDeposit(receiver));
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        if (paused()) return 0;
        return Math.min(convertToAssets(balanceOf(owner)), availableLiquidity());
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (paused()) return 0;
        return Math.min(balanceOf(owner), convertToShares(availableLiquidity()));
    }

    // ---------------------------------------------------------------- deposits

    function depositWithPermit(uint256 assets, address receiver, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        returns (uint256)
    {
        try IERC20Permit(asset()).permit(msg.sender, address(this), assets, deadline, v, r, s) {} catch {}
        return deposit(assets, receiver);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        uint256 cap = maxDeposit(receiver);
        if (assets > cap) revert DepositCapExceeded(cap);
        super._deposit(caller, receiver, assets, shares);
        _rebalance();
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
    {
        _ensureIdle(assets);
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /// @notice Keep `bufferBps` of assets idle and supply the rest to Morpho.
    function rebalance() external onlyRole(KEEPER_ROLE) {
        _rebalance();
    }

    function _rebalance() internal {
        if (address(strategy) == address(0)) return;
        uint256 target = totalAssets().mulDiv(bufferBps, 10_000);
        uint256 cur = idle();
        if (cur > target) {
            uint256 excess = cur - target;
            IERC20(asset()).forceApprove(address(strategy), excess);
            strategy.deploy(excess);
        }
        emit Rebalanced(idle(), strategy.totalAssets());
    }

    function _ensureIdle(uint256 assets) internal {
        uint256 cur = idle();
        if (cur >= assets) return;
        if (address(strategy) != address(0)) strategy.free(assets - cur);
        uint256 nowIdle = idle();
        if (nowIdle < assets) revert InsufficientLiquidity(nowIdle);
    }

    // ---------------------------------------------------------------- fee income

    /// @notice Top up the vault with x402 facilitator or protocol-owned LP fee share.
    function notifyFeeIncome(uint256 assets, bytes32 source) external {
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), assets);
        totalFeeIncome += assets;
        emit FeeIncome(msg.sender, assets, source);
    }

    // ---------------------------------------------------------------- withdrawal queue

    function requestCount() external view returns (uint256) {
        return requests.length;
    }

    /// @notice Queue a redemption when Morpho liquidity is thin. Shares are held by the vault
    ///         and keep earning until processed at the then-current share price.
    function requestRedeem(uint256 shares, address receiver) external whenNotPaused returns (uint256 requestId) {
        _transfer(msg.sender, address(this), shares);
        requestId = requests.length;
        requests.push(WithdrawalRequest(msg.sender, receiver, uint128(shares), uint64(block.timestamp), false));
        queuedShares += shares;
        emit WithdrawalRequested(requestId, msg.sender, receiver, shares);
    }

    function cancelRequest(uint256 requestId) external {
        WithdrawalRequest storage req = requests[requestId];
        if (req.owner != msg.sender) revert NotRequestOwner();
        require(!req.done, "done");
        req.done = true;
        queuedShares -= req.shares;
        _transfer(address(this), msg.sender, req.shares);
        emit WithdrawalCancelled(requestId, msg.sender, req.shares);
    }

    /// @notice Process up to `maxCount` queued requests in order while liquidity allows.
    function processQueue(uint256 maxCount) external whenNotPaused returns (uint256 processed) {
        uint256 i = nextRequestToProcess;
        while (i < requests.length && processed < maxCount) {
            WithdrawalRequest storage req = requests[i];
            if (!req.done) {
                uint256 assets = previewRedeem(req.shares);
                if (assets > availableLiquidity()) break;
                _ensureIdle(assets);
                req.done = true;
                queuedShares -= req.shares;
                _burn(address(this), req.shares);
                IERC20(asset()).safeTransfer(req.receiver, assets);
                emit WithdrawalProcessed(i, req.owner, req.shares, assets);
                emit Withdraw(address(this), req.receiver, req.owner, assets, req.shares);
                ++processed;
            }
            ++i;
        }
        nextRequestToProcess = i;
    }

    // ---------------------------------------------------------------- admin

    function setStrategy(MorphoLenderStrategy strategy_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(address(strategy) == address(0) || strategy.totalAssets() == 0, "strategy has assets");
        strategy = strategy_;
        emit StrategySet(address(strategy_));
    }

    function setBufferBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(bps <= 10_000, "bps");
        bufferBps = bps;
        emit BufferSet(bps);
    }

    function setDepositCap(uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        depositCap = cap;
        emit DepositCapSet(cap);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }
}
