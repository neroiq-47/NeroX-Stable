// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title AutoSweeper
/// @notice Opt-in rule for x402 sellers: when the payout wallet's NRX balance passes a
///         threshold, deposit the excess into sNRX for the seller. Off by default. The seller
///         grants a capped NRX allowance (the sweep budget), never an unlimited one.
contract AutoSweeper {
    using SafeERC20 for IERC20;

    struct Rule {
        bool enabled;
        uint128 threshold;
        uint128 keep;
    }

    IERC20 public immutable nrx;
    IERC4626 public immutable sNRX;
    mapping(address => Rule) public rules;

    event RuleSet(address indexed account, bool enabled, uint256 threshold, uint256 keep);
    event Swept(address indexed account, uint256 assets, uint256 shares);

    constructor(IERC20 nrx_, IERC4626 sNRX_) {
        nrx = nrx_;
        sNRX = sNRX_;
    }

    function setRule(bool enabled, uint128 threshold, uint128 keep) external {
        require(keep <= threshold, "keep > threshold");
        rules[msg.sender] = Rule(enabled, threshold, keep);
        emit RuleSet(msg.sender, enabled, threshold, keep);
    }

    function sweepable(address account) public view returns (uint256) {
        Rule memory r = rules[account];
        if (!r.enabled) return 0;
        uint256 bal = nrx.balanceOf(account);
        if (bal < r.threshold) return 0;
        uint256 amount = bal - r.keep;
        uint256 allowance = nrx.allowance(account, address(this));
        return amount > allowance ? allowance : amount;
    }

    /// @notice Anyone (the NeroX keeper) may trigger a sweep; funds only ever go to the
    ///         account's own sNRX balance.
    function sweep(address account) external returns (uint256 shares) {
        uint256 amount = sweepable(account);
        if (amount == 0) return 0;
        nrx.safeTransferFrom(account, address(this), amount);
        nrx.forceApprove(address(sNRX), amount);
        shares = sNRX.deposit(amount, account);
        emit Swept(account, amount, shares);
    }
}
