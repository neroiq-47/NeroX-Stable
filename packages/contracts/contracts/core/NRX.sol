// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title NRX — NeroX USD
/// @notice 1:1 USD payment token, backed by USDC held in the NeroPSM on each chain.
///         Built for x402: EIP-2612 permit and EIP-3009 transfer/receiveWithAuthorization,
///         so facilitators settle gaslessly for the payer. NRX pays no yield.
/// @dev FiatToken-style controls: role-gated minters with per-minter allowances, a per-chain
///      supply cap, pause and a blocklist. Minters are the PSM and the CCIP burn/mint pool.
contract NRX is ERC20, ERC20Permit, AccessControl, Pausable {
    bytes32 public constant MINTER_ADMIN_ROLE = keccak256("MINTER_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant BLOCKLISTER_ROLE = keccak256("BLOCKLISTER_ROLE");

    // EIP-3009 typehashes, matching USDC's FiatTokenV2.
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    /// @notice Hard cap on NRX that can exist on this chain (capped beta).
    uint256 public supplyCap;
    /// @notice Remaining mint allowance per minter. Zero means not a minter.
    mapping(address => uint256) public minterAllowance;
    mapping(address => bool) public isMinter;
    mapping(address => bool) public blocklisted;
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    event MinterConfigured(address indexed minter, uint256 allowance);
    event MinterRemoved(address indexed minter);
    event SupplyCapUpdated(uint256 cap);
    event Blocklisted(address indexed account, bool status);
    event Mint(address indexed minter, address indexed to, uint256 amount);
    event Burn(address indexed burner, uint256 amount);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error NotMinter();
    error MinterAllowanceExceeded();
    error SupplyCapExceeded();
    error AccountBlocklisted(address account);
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidSignature();
    error CallerMustBePayee();

    constructor(address admin, uint256 cap) ERC20("NeroX USD", "NRX") ERC20Permit("NeroX USD") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ADMIN_ROLE, admin);
        supplyCap = cap;
        emit SupplyCapUpdated(cap);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice EIP-712 domain version, read by x402 clients from `extra.version`.
    function version() external pure returns (string memory) {
        return "1";
    }

    // ---------------------------------------------------------------- admin

    function configureMinter(address minter, uint256 allowance) external onlyRole(MINTER_ADMIN_ROLE) {
        isMinter[minter] = true;
        minterAllowance[minter] = allowance;
        emit MinterConfigured(minter, allowance);
    }

    function removeMinter(address minter) external onlyRole(MINTER_ADMIN_ROLE) {
        isMinter[minter] = false;
        minterAllowance[minter] = 0;
        emit MinterRemoved(minter);
    }

    function setSupplyCap(uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        supplyCap = cap;
        emit SupplyCapUpdated(cap);
    }

    function setBlocklisted(address account, bool status) external onlyRole(BLOCKLISTER_ROLE) {
        blocklisted[account] = status;
        emit Blocklisted(account, status);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------- mint / burn

    function mint(address to, uint256 amount) external {
        if (!isMinter[msg.sender]) revert NotMinter();
        uint256 allowance = minterAllowance[msg.sender];
        if (amount > allowance) revert MinterAllowanceExceeded();
        if (totalSupply() + amount > supplyCap) revert SupplyCapExceeded();
        unchecked {
            minterAllowance[msg.sender] = allowance - amount;
        }
        _mint(to, amount);
        emit Mint(msg.sender, to, amount);
    }

    /// @notice Minters burn from their own balance (PSM on redeem, token pool on bridge-out).
    ///         Burning restores the minter's allowance so caps track outstanding supply.
    function burn(uint256 amount) external {
        if (!isMinter[msg.sender]) revert NotMinter();
        _burn(msg.sender, amount);
        minterAllowance[msg.sender] += amount;
        emit Burn(msg.sender, amount);
    }

    // ---------------------------------------------------------------- EIP-3009

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        _useAuthorization(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
        _transfer(from, to, value);
    }

    /// @dev Split-signature overload used by USDC-compatible facilitators.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _useAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v)
        );
        _transfer(from, to, value);
    }

    /// @notice Like transferWithAuthorization, but only the payee may submit it — prevents
    ///         front-running when the payee is a contract that acts on receipt.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _useAuthorization(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
        _transfer(from, to, value);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, bytes calldata signature) external {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)));
        if (!SignatureChecker.isValidSignatureNow(authorizer, digest, signature)) revert InvalidSignature();
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _useAuthorization(
        bytes32 typehash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) private {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationStates[from][nonce]) revert AuthorizationAlreadyUsed();
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce)));
        // SignatureChecker supports EOAs and ERC-1271 smart accounts (agent wallets).
        if (!SignatureChecker.isValidSignatureNow(from, digest, signature)) revert InvalidSignature();
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }

    // ---------------------------------------------------------------- hooks

    function _update(address from, address to, uint256 value) internal override {
        _requireNotPaused();
        if (blocklisted[from]) revert AccountBlocklisted(from);
        if (blocklisted[to]) revert AccountBlocklisted(to);
        if (blocklisted[msg.sender]) revert AccountBlocklisted(msg.sender);
        super._update(from, to, value);
    }
}
