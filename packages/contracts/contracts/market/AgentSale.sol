// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IdentityRegistry} from "./ERC8004Registries.sol";
import {NeroJobs} from "./NeroJobs.sol";

/// @title AgentSale — buy a whole agent
/// @notice Atomic swap of NRX for an ERC-8004 identity token. Ownership, reputation history
///         and the payout wallet move together. Whole agents only: no fractional revenue tokens.
contract AgentSale is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Listing {
        address seller;
        uint256 price;
        uint64 listedAt;
        bool active;
    }

    struct Offer {
        address buyer;
        uint256 amount;
        uint64 expiresAt;
        bool active;
    }

    IERC20 public immutable nrx;
    IdentityRegistry public immutable identity;
    NeroJobs public immutable jobs;
    address public treasury;
    uint256 public saleFeeBps = 250; // 2.5%

    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Offer[]) internal _offers;

    event Listed(uint256 indexed agentId, address indexed seller, uint256 price);
    event Unlisted(uint256 indexed agentId);
    event Sold(uint256 indexed agentId, address indexed seller, address indexed buyer, uint256 price, uint256 fee);
    event OfferMade(uint256 indexed agentId, uint256 indexed offerId, address indexed buyer, uint256 amount, uint64 expiresAt);
    event OfferWithdrawn(uint256 indexed agentId, uint256 indexed offerId);

    error NotOwner();
    error NotListed();
    error PriceChanged(uint256 price);
    error OpenJobs(uint256 count);
    error OfferInactive();

    constructor(address admin, IERC20 nrx_, IdentityRegistry identity_, NeroJobs jobs_, address treasury_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        nrx = nrx_;
        identity = identity_;
        jobs = jobs_;
        treasury = treasury_;
    }

    function offers(uint256 agentId) external view returns (Offer[] memory) {
        return _offers[agentId];
    }

    /// @notice List an agent. The seller must approve this contract for the identity token.
    function list(uint256 agentId, uint256 price) external {
        if (identity.ownerOf(agentId) != msg.sender) revert NotOwner();
        listings[agentId] = Listing(msg.sender, price, uint64(block.timestamp), true);
        emit Listed(agentId, msg.sender, price);
    }

    function unlist(uint256 agentId) external {
        if (listings[agentId].seller != msg.sender) revert NotOwner();
        delete listings[agentId];
        emit Unlisted(agentId);
    }

    function buy(uint256 agentId, uint256 expectedPrice) external nonReentrant {
        Listing memory l = listings[agentId];
        if (!l.active || identity.ownerOf(agentId) != l.seller) revert NotListed();
        if (l.price != expectedPrice) revert PriceChanged(l.price);
        _settle(agentId, l.seller, msg.sender, l.price, msg.sender);
    }

    /// @notice Escrow an NRX offer for an agent, listed or not.
    function makeOffer(uint256 agentId, uint256 amount, uint64 expiresAt) external returns (uint256 offerId) {
        identity.ownerOf(agentId); // reverts for unknown agents
        nrx.safeTransferFrom(msg.sender, address(this), amount);
        offerId = _offers[agentId].length;
        _offers[agentId].push(Offer(msg.sender, amount, expiresAt, true));
        emit OfferMade(agentId, offerId, msg.sender, amount, expiresAt);
    }

    function withdrawOffer(uint256 agentId, uint256 offerId) external nonReentrant {
        Offer storage o = _offers[agentId][offerId];
        if (!o.active || o.buyer != msg.sender) revert OfferInactive();
        o.active = false;
        nrx.safeTransfer(msg.sender, o.amount);
        emit OfferWithdrawn(agentId, offerId);
    }

    function acceptOffer(uint256 agentId, uint256 offerId) external nonReentrant {
        if (identity.ownerOf(agentId) != msg.sender) revert NotOwner();
        Offer storage o = _offers[agentId][offerId];
        if (!o.active || o.expiresAt < block.timestamp) revert OfferInactive();
        o.active = false;
        _settle(agentId, msg.sender, o.buyer, o.amount, address(this));
    }

    function _settle(uint256 agentId, address seller, address buyer, uint256 price, address payer) internal {
        // Selling an agent mid-job would strand its buyers: settle open jobs first.
        uint256 open = jobs.openJobCount(agentId);
        if (open > 0) revert OpenJobs(open);
        uint256 fee = (price * saleFeeBps) / 10_000;
        delete listings[agentId];
        if (payer == address(this)) {
            nrx.safeTransfer(seller, price - fee);
            if (fee > 0) nrx.safeTransfer(treasury, fee);
        } else {
            nrx.safeTransferFrom(payer, seller, price - fee);
            if (fee > 0) nrx.safeTransferFrom(payer, treasury, fee);
        }
        identity.transferFrom(seller, buyer, agentId);
        emit Sold(agentId, seller, buyer, price, fee);
    }

    function setSaleFee(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(bps <= 1_000, "fee");
        saleFeeBps = bps;
    }
}
