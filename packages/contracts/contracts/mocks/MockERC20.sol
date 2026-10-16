// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice Demo-chain token (USDC, cbBTC, wstETH) with EIP-2612 permit and a capped faucet.
contract MockERC20 is ERC20, ERC20Permit {
    uint8 private immutable _decimals;
    uint256 public immutable faucetAmount;
    address public immutable owner;
    mapping(address => uint256) public lastFaucet;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 faucetAmount_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        _decimals = decimals_;
        faucetAmount = faucetAmount_;
        owner = msg.sender;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function version() external pure returns (string memory) {
        return "1";
    }

    /// @notice Demo faucet: one drip per address per hour.
    function faucet() external {
        require(block.timestamp >= lastFaucet[msg.sender] + 1 hours || lastFaucet[msg.sender] == 0, "faucet: wait");
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "owner");
        _mint(to, amount);
    }
}
