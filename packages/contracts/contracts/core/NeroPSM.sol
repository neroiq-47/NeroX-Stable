// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface INRXMintable is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
}

/// @title NeroPSM — Peg Stability Module
/// @notice Swaps USDC for NRX at 1:1 and back, per chain. Reserve USDC never leaves this
///         contract, so reserve income (if any) stays with the issuer and is never routed to sNRX.
/// @dev Daily mint/redeem caps reset every UTC day; a global cap bounds total PSM-minted NRX.
contract NeroPSM is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    uint256 public constant MAX_FEE_BPS = 100; // 1%

    IERC20 public immutable usdc;
    INRXMintable public immutable nrx;

    uint256 public mintFeeBps;
    uint256 public redeemFeeBps;
    address public feeRecipient;

    uint256 public dailyMintCap;
    uint256 public dailyRedeemCap;
    uint256 public globalMintCap;

    uint256 public currentDay;
    uint256 public mintedToday;
    uint256 public redeemedToday;
    /// @notice NRX outstanding that was minted by this PSM (minted minus redeemed).
    uint256 public outstanding;

    event Minted(address indexed account, address indexed to, uint256 usdcIn, uint256 nrxOut, uint256 fee);
    event Redeemed(address indexed account, address indexed to, uint256 nrxIn, uint256 usdcOut, uint256 fee);
    event CapsUpdated(uint256 dailyMintCap, uint256 dailyRedeemCap, uint256 globalMintCap);
    event FeesUpdated(uint256 mintFeeBps, uint256 redeemFeeBps, address feeRecipient);
    event ReservesRebalanced(address indexed to, uint256 amount);

    error ZeroAmount();
    error DailyMintCapExceeded(uint256 remaining);
    error DailyRedeemCapExceeded(uint256 remaining);
    error GlobalMintCapExceeded(uint256 remaining);
    error InsufficientReserves(uint256 available);
    error FeeTooHigh();

    constructor(
        address admin,
        address guardian,
        IERC20 usdc_,
        INRXMintable nrx_,
        uint256 dailyMintCap_,
        uint256 dailyRedeemCap_,
        uint256 globalMintCap_
    ) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
        usdc = usdc_;
        nrx = nrx_;
        feeRecipient = admin;
        dailyMintCap = dailyMintCap_;
        dailyRedeemCap = dailyRedeemCap_;
        globalMintCap = globalMintCap_;
        currentDay = block.timestamp / 1 days;
        emit CapsUpdated(dailyMintCap_, dailyRedeemCap_, globalMintCap_);
    }

    // ---------------------------------------------------------------- views

    function reserves() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function remainingDailyMint() public view returns (uint256) {
        uint256 used = block.timestamp / 1 days == currentDay ? mintedToday : 0;
        return used >= dailyMintCap ? 0 : dailyMintCap - used;
    }

    function remainingDailyRedeem() public view returns (uint256) {
        uint256 used = block.timestamp / 1 days == currentDay ? redeemedToday : 0;
        return used >= dailyRedeemCap ? 0 : dailyRedeemCap - used;
    }

    function remainingGlobalMint() public view returns (uint256) {
        return outstanding >= globalMintCap ? 0 : globalMintCap - outstanding;
    }

    function quoteMint(uint256 usdcIn) public view returns (uint256 nrxOut, uint256 fee) {
        fee = (usdcIn * mintFeeBps) / 10_000;
        nrxOut = usdcIn - fee;
    }

    function quoteRedeem(uint256 nrxIn) public view returns (uint256 usdcOut, uint256 fee) {
        fee = (nrxIn * redeemFeeBps) / 10_000;
        usdcOut = nrxIn - fee;
    }

    // ---------------------------------------------------------------- mint / redeem

    function mint(uint256 usdcIn, address to) public nonReentrant whenNotPaused returns (uint256 nrxOut) {
        if (usdcIn == 0) revert ZeroAmount();
        _rollDay();
        uint256 remDaily = remainingDailyMint();
        if (usdcIn > remDaily) revert DailyMintCapExceeded(remDaily);
        uint256 remGlobal = remainingGlobalMint();
        uint256 fee;
        (nrxOut, fee) = quoteMint(usdcIn);
        if (nrxOut > remGlobal) revert GlobalMintCapExceeded(remGlobal);

        mintedToday += usdcIn;
        outstanding += nrxOut;
        usdc.safeTransferFrom(msg.sender, address(this), usdcIn);
        if (fee > 0) usdc.safeTransfer(feeRecipient, fee);
        nrx.mint(to, nrxOut);
        emit Minted(msg.sender, to, usdcIn, nrxOut, fee);
    }

    /// @notice One-prompt mint: USDC EIP-2612 permit signature + mint in a single transaction.
    function mintWithPermit(uint256 usdcIn, address to, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        returns (uint256)
    {
        // Ignore failure so a front-run permit does not block the mint (allowance check still applies).
        try IERC20Permit(address(usdc)).permit(msg.sender, address(this), usdcIn, deadline, v, r, s) {} catch {}
        return mint(usdcIn, to);
    }

    function redeem(uint256 nrxIn, address to) public nonReentrant whenNotPaused returns (uint256 usdcOut) {
        if (nrxIn == 0) revert ZeroAmount();
        _rollDay();
        uint256 remDaily = remainingDailyRedeem();
        if (nrxIn > remDaily) revert DailyRedeemCapExceeded(remDaily);
        uint256 fee;
        (usdcOut, fee) = quoteRedeem(nrxIn);
        uint256 available = usdc.balanceOf(address(this));
        if (usdcOut + fee > available) revert InsufficientReserves(available);

        redeemedToday += nrxIn;
        outstanding = nrxIn > outstanding ? 0 : outstanding - nrxIn;
        IERC20(address(nrx)).safeTransferFrom(msg.sender, address(this), nrxIn);
        nrx.burn(nrxIn);
        if (fee > 0) usdc.safeTransfer(feeRecipient, fee);
        usdc.safeTransfer(to, usdcOut);
        emit Redeemed(msg.sender, to, nrxIn, usdcOut, fee);
    }

    function redeemWithPermit(uint256 nrxIn, address to, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        returns (uint256)
    {
        try IERC20Permit(address(nrx)).permit(msg.sender, address(this), nrxIn, deadline, v, r, s) {} catch {}
        return redeem(nrxIn, to);
    }

    // ---------------------------------------------------------------- admin

    function setCaps(uint256 dailyMint, uint256 dailyRedeem, uint256 globalMint) external onlyRole(DEFAULT_ADMIN_ROLE) {
        dailyMintCap = dailyMint;
        dailyRedeemCap = dailyRedeem;
        globalMintCap = globalMint;
        emit CapsUpdated(dailyMint, dailyRedeem, globalMint);
    }

    function setFees(uint256 mintBps, uint256 redeemBps, address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (mintBps > MAX_FEE_BPS || redeemBps > MAX_FEE_BPS) revert FeeTooHigh();
        mintFeeBps = mintBps;
        redeemFeeBps = redeemBps;
        feeRecipient = recipient;
        emit FeesUpdated(mintBps, redeemBps, recipient);
    }

    /// @notice Move USDC to another chain's PSM (via CCTP in production) when NRX supply
    ///         has migrated across chains. Admin-only, behind the timelock.
    function rebalance(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        usdc.safeTransfer(to, amount);
        emit ReservesRebalanced(to, amount);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }

    function _rollDay() private {
        uint256 day = block.timestamp / 1 days;
        if (day != currentDay) {
            currentDay = day;
            mintedToday = 0;
            redeemedToday = 0;
        }
    }
}
