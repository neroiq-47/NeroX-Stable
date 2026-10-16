// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title SellerBond
/// @notice Sellers and pool evaluators post bonds in sNRX. The bond keeps earning sNRX
///         returns while posted. It is slashed only on a NeroJobs ruling, and withdrawals
///         wait out a timelock so a seller cannot pull the bond ahead of a ruling.
contract SellerBond is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant JOBS_ROLE = keccak256("JOBS_ROLE");

    IERC4626 public immutable sNRX;
    uint256 public withdrawDelay = 7 days;

    struct PendingWithdrawal {
        uint256 shares;
        uint64 unlockAt;
    }

    mapping(address => uint256) public shares;
    /// @notice NRX value currently committed to open jobs.
    mapping(address => uint256) public lockedAssets;
    mapping(address => PendingWithdrawal) public pending;

    event Deposited(address indexed account, uint256 shares);
    event WithdrawRequested(address indexed account, uint256 shares, uint64 unlockAt);
    event Withdrawn(address indexed account, uint256 shares);
    event Locked(address indexed account, uint256 assets);
    event Unlocked(address indexed account, uint256 assets);
    event Slashed(address indexed account, address indexed to, uint256 assets, uint256 shares);

    error BondTooLow(uint256 free, uint256 required);
    error StillLocked(uint64 unlockAt);

    constructor(address admin, IERC4626 sNRX_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        sNRX = sNRX_;
    }

    // ---------------------------------------------------------------- views

    function bondValue(address account) public view returns (uint256) {
        return sNRX.convertToAssets(shares[account]);
    }

    /// @notice Bond value not committed to open jobs and not queued for withdrawal.
    function freeValue(address account) public view returns (uint256) {
        uint256 v = sNRX.convertToAssets(shares[account] - pending[account].shares);
        uint256 l = lockedAssets[account];
        return v > l ? v - l : 0;
    }

    // ---------------------------------------------------------------- bonds

    function deposit(uint256 shareAmount) external {
        IERC20(address(sNRX)).safeTransferFrom(msg.sender, address(this), shareAmount);
        shares[msg.sender] += shareAmount;
        emit Deposited(msg.sender, shareAmount);
    }

    function requestWithdraw(uint256 shareAmount) external {
        uint256 freeShares = sNRX.convertToShares(freeValue(msg.sender));
        if (shareAmount > freeShares) revert BondTooLow(sNRX.convertToAssets(freeShares), sNRX.convertToAssets(shareAmount));
        uint64 unlockAt = uint64(block.timestamp + withdrawDelay);
        pending[msg.sender] = PendingWithdrawal(pending[msg.sender].shares + shareAmount, unlockAt);
        emit WithdrawRequested(msg.sender, shareAmount, unlockAt);
    }

    function withdraw() external {
        PendingWithdrawal memory p = pending[msg.sender];
        if (block.timestamp < p.unlockAt) revert StillLocked(p.unlockAt);
        // A slash may have reduced the balance below the queued amount.
        uint256 amount = Math.min(p.shares, shares[msg.sender]);
        delete pending[msg.sender];
        shares[msg.sender] -= amount;
        IERC20(address(sNRX)).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------- jobs hooks

    function lock(address account, uint256 assets) external onlyRole(JOBS_ROLE) {
        uint256 f = freeValue(account);
        if (f < assets) revert BondTooLow(f, assets);
        lockedAssets[account] += assets;
        emit Locked(account, assets);
    }

    function unlock(address account, uint256 assets) external onlyRole(JOBS_ROLE) {
        uint256 l = lockedAssets[account];
        lockedAssets[account] = assets > l ? 0 : l - assets;
        emit Unlocked(account, assets);
    }

    /// @notice Move up to `assets` worth of the account's bond to `to` (the wronged buyer).
    function slash(address account, address to, uint256 assets) external onlyRole(JOBS_ROLE) returns (uint256 slashed) {
        uint256 s = Math.min(sNRX.convertToShares(assets), shares[account]);
        shares[account] -= s;
        if (pending[account].shares > shares[account]) pending[account].shares = shares[account];
        slashed = sNRX.convertToAssets(s);
        IERC20(address(sNRX)).safeTransfer(to, s);
        emit Slashed(account, to, slashed, s);
    }

    function setWithdrawDelay(uint256 delay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        withdrawDelay = delay;
    }
}
