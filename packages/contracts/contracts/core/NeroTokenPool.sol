// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IBurnMintNRX is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
}

/// @title NeroTokenPool — CCIP-style burn/mint token pool
/// @notice One canonical NRX supply across chains: burn on the source chain, mint on the
///         destination, with per-lane token-bucket rate limits in both directions.
/// @dev Local stand-in for Chainlink's BurnMintTokenPool + Router. The demo "DON" is a
///      committee of signers with a 2-of-3 quorum, so a single forged attestation cannot mint
///      (the Kelp 1-of-1 DVN failure). Production uses Chainlink CCIP lanes.
contract NeroTokenPool is AccessControl, Pausable {
    using SafeERC20 for IERC20;

    struct RateLimit {
        uint128 tokens; // current bucket
        uint32 lastUpdated;
        bool isEnabled;
        uint128 capacity;
        uint128 rate; // tokens refilled per second
    }

    struct Lane {
        bool enabled;
        address remotePool;
        RateLimit outbound;
        RateLimit inbound;
    }

    IBurnMintNRX public immutable token;
    uint64 public immutable localChainSelector;
    uint256 public feeWei; // flat native fee per message (CCIP quotes vary)
    uint256 public nonce;
    uint256 public quorum;

    mapping(uint64 => Lane) internal _lanes;
    uint64[] public remoteSelectors;
    mapping(address => bool) public isSigner;
    uint256 public signerCount;
    mapping(bytes32 => bool) public executed;

    event LaneConfigured(uint64 indexed remoteChainSelector, address remotePool, uint128 capacity, uint128 rate);
    event CCIPSendRequested(
        bytes32 indexed messageId,
        uint64 indexed destChainSelector,
        address indexed sender,
        address receiver,
        uint256 amount,
        uint256 fee,
        uint256 nonce
    );
    event CCIPMessageExecuted(
        bytes32 indexed messageId, uint64 indexed sourceChainSelector, address indexed receiver, uint256 amount
    );
    event SignerSet(address indexed signer, bool status);

    error LaneDisabled(uint64 selector);
    error RateLimitExceeded(uint256 available);
    error InsufficientFee(uint256 required);
    error AlreadyExecuted(bytes32 messageId);
    error QuorumNotMet(uint256 valid, uint256 required);

    constructor(address admin, IBurnMintNRX token_, uint64 localChainSelector_, uint256 feeWei_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        token = token_;
        localChainSelector = localChainSelector_;
        feeWei = feeWei_;
    }

    // ---------------------------------------------------------------- config

    function configureLane(uint64 remote, address remotePool, uint128 capacity, uint128 rate)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        Lane storage l = _lanes[remote];
        if (!l.enabled && l.remotePool == address(0)) remoteSelectors.push(remote);
        l.enabled = true;
        l.remotePool = remotePool;
        l.outbound = RateLimit(capacity, uint32(block.timestamp), true, capacity, rate);
        l.inbound = RateLimit(capacity, uint32(block.timestamp), true, capacity, rate);
        emit LaneConfigured(remote, remotePool, capacity, rate);
    }

    function setSigner(address signer, bool status) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (isSigner[signer] != status) {
            isSigner[signer] = status;
            signerCount = status ? signerCount + 1 : signerCount - 1;
            emit SignerSet(signer, status);
        }
    }

    function setQuorum(uint256 q) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(q >= 2 && q <= signerCount, "quorum");
        quorum = q;
    }

    function setFee(uint256 feeWei_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        feeWei = feeWei_;
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------- views

    function lane(uint64 remote) external view returns (Lane memory) {
        return _lanes[remote];
    }

    function getFee(uint64) external view returns (uint256) {
        return feeWei;
    }

    /// @notice Tokens that can leave on this lane right now (the bridge screen's headroom).
    function outboundHeadroom(uint64 remote) external view returns (uint256) {
        return _available(_lanes[remote].outbound);
    }

    function inboundHeadroom(uint64 remote) external view returns (uint256) {
        return _available(_lanes[remote].inbound);
    }

    function messageDigest(
        bytes32 messageId,
        uint64 sourceChainSelector,
        address sender,
        address receiver,
        uint256 amount,
        uint256 msgNonce
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                messageId, sourceChainSelector, localChainSelector, address(this), sender, receiver, amount, msgNonce
            )
        );
    }

    // ---------------------------------------------------------------- send / execute

    /// @notice Burn NRX here and request a mint on `destChainSelector`.
    function ccipSend(uint64 destChainSelector, address receiver, uint256 amount)
        external
        payable
        whenNotPaused
        returns (bytes32 messageId)
    {
        Lane storage l = _lanes[destChainSelector];
        if (!l.enabled) revert LaneDisabled(destChainSelector);
        if (msg.value < feeWei) revert InsufficientFee(feeWei);
        _consume(l.outbound, amount);

        IERC20(address(token)).safeTransferFrom(msg.sender, address(this), amount);
        token.burn(amount);

        uint256 n = ++nonce;
        messageId = keccak256(abi.encode(localChainSelector, destChainSelector, address(this), msg.sender, receiver, amount, n));
        emit CCIPSendRequested(messageId, destChainSelector, msg.sender, receiver, amount, msg.value, n);
    }

    /// @notice Mint NRX for a message burned on `sourceChainSelector`, once a quorum of
    ///         committee signatures attests to it. Callable by anyone (the relayer).
    function executeMessage(
        bytes32 messageId,
        uint64 sourceChainSelector,
        address sender,
        address receiver,
        uint256 amount,
        uint256 msgNonce,
        bytes[] calldata signatures
    ) external whenNotPaused {
        Lane storage l = _lanes[sourceChainSelector];
        if (!l.enabled) revert LaneDisabled(sourceChainSelector);
        if (executed[messageId]) revert AlreadyExecuted(messageId);
        bytes32 expectedId = keccak256(
            abi.encode(sourceChainSelector, localChainSelector, l.remotePool, sender, receiver, amount, msgNonce)
        );
        require(expectedId == messageId, "message id");

        bytes32 digest =
            MessageHashUtils.toEthSignedMessageHash(messageDigest(messageId, sourceChainSelector, sender, receiver, amount, msgNonce));
        uint256 valid;
        address last;
        for (uint256 i; i < signatures.length; ++i) {
            address s = ECDSA.recover(digest, signatures[i]);
            require(s > last, "signers unsorted"); // strictly increasing => no duplicates
            last = s;
            if (isSigner[s]) ++valid;
        }
        if (valid < quorum) revert QuorumNotMet(valid, quorum);

        _consume(l.inbound, amount);
        executed[messageId] = true;
        token.mint(receiver, amount);
        emit CCIPMessageExecuted(messageId, sourceChainSelector, receiver, amount);
    }

    function withdrawFees(address payable to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        to.transfer(address(this).balance);
    }

    // ---------------------------------------------------------------- rate limits

    function _available(RateLimit memory b) internal view returns (uint256) {
        if (!b.isEnabled) return type(uint256).max;
        uint256 refilled = uint256(b.tokens) + (block.timestamp - b.lastUpdated) * b.rate;
        return refilled > b.capacity ? b.capacity : refilled;
    }

    function _consume(RateLimit storage b, uint256 amount) internal {
        if (!b.isEnabled) return;
        uint256 avail = _available(b);
        if (amount > avail) revert RateLimitExceeded(avail);
        b.tokens = uint128(avail - amount);
        b.lastUpdated = uint32(block.timestamp);
    }
}
