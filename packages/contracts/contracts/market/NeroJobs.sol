// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IdentityRegistry} from "./ERC8004Registries.sol";
import {SellerBond} from "./SellerBond.sol";

/// @title NeroJobs — ERC-8183 Agentic Commerce escrow, settled in NRX
/// @notice Open → Funded → Submitted → Completed / Rejected / Expired. One evaluator per job
///         decides who gets paid. Escrow sits in NRX (not sNRX) so ownership of funds is clear
///         at release. A platform fee is taken on completion only.
/// @dev Hooks in this implementation: seller-bond lock/unlock/slash and a paid-client record
///      that the market's reputation ranking reads (only paying clients count as reviewers).
contract NeroJobs is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    enum EvaluatorKind {
        Buyer,
        Contract,
        Pool
    }

    struct Job {
        address client;
        address provider;
        address evaluator;
        uint256 agentId;
        uint256 budget;
        uint256 evaluatorFee;
        uint256 bondLocked;
        address bondOwner;
        uint64 createdAt;
        uint64 fundedAt;
        uint64 submittedAt;
        uint64 expiredAt;
        Status status;
        EvaluatorKind kind;
        bytes32 deliverable;
        string description;
    }

    IERC20 public immutable nrx;
    IdentityRegistry public immutable identity;
    SellerBond public immutable bonds;
    address public treasury;

    uint256 public platformFeeBps = 300; // 3% on completion
    uint256 public evaluatorFeeBps = 150; // 1.5%, pool evaluators only, paid by buyer
    uint256 public bondBps = 1_000; // seller bond covers 10% of open job volume
    uint256 public rejectPenaltyBps = 1_000; // slashed to buyer on a non-buyer rejection or non-delivery
    uint256 public budgetCap = 1_000e6; // beta cap: 1,000 NRX per job
    uint256 public poolThreshold = 500e6; // jobs above this must use a random pool evaluator
    uint256 public minEvaluatorBond = 500e6;

    Job[] internal _jobs;
    mapping(address => bool) public isContractEvaluator;
    address[] public evaluatorPool;
    mapping(address => bool) public inPool;
    mapping(address => uint64) public feeWaiverUntil;
    mapping(uint256 => mapping(address => bool)) public isPaidClient;
    mapping(uint256 => uint256) public openJobCount;

    event JobCreated(
        uint256 indexed jobId,
        uint256 indexed agentId,
        address indexed client,
        address provider,
        address evaluator,
        uint8 kind,
        uint256 budget,
        uint64 expiredAt,
        string description
    );
    event BudgetSet(uint256 indexed jobId, uint256 budget);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 budget, uint256 evaluatorFee);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, uint256 toProvider, uint256 platformFee, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed evaluator, uint256 refunded, uint256 slashed, bytes32 reason);
    event JobExpired(uint256 indexed jobId, uint256 refunded, uint256 slashed);
    event EvaluatorRegistered(address indexed evaluator, bool contractEvaluator);
    event FeeWaiverSet(address indexed seller, uint64 until);

    error InvalidStatus(Status status);
    error NotAuthorized();
    error SharedOwner();
    error BudgetMismatch(uint256 budget);
    error BudgetAboveCap(uint256 cap);
    error PoolEvaluatorRequired();
    error NotPoolEvaluator();
    error NotExpired();
    error BadExpiry();

    constructor(address admin, IERC20 nrx_, IdentityRegistry identity_, SellerBond bonds_, address treasury_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        nrx = nrx_;
        identity = identity_;
        bonds = bonds_;
        treasury = treasury_;
    }

    // ---------------------------------------------------------------- views

    function jobCount() external view returns (uint256) {
        return _jobs.length;
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function poolSize() external view returns (uint256) {
        return evaluatorPool.length;
    }

    function feeFor(address seller, uint256 budget) public view returns (uint256) {
        if (feeWaiverUntil[seller] >= block.timestamp) return 0;
        return (budget * platformFeeBps) / 10_000;
    }

    // ---------------------------------------------------------------- lifecycle

    /// @param evaluator The buyer's own address, a registered contract evaluator, or
    ///        address(0) to have a bonded pool evaluator picked at random.
    function createJob(uint256 agentId, address evaluator, uint64 expiredAt, string calldata description, uint256 budget)
        external
        returns (uint256 jobId)
    {
        if (expiredAt <= block.timestamp + 1 hours) revert BadExpiry();
        if (budget > budgetCap) revert BudgetAboveCap(budgetCap);
        address provider = identity.getAgentWallet(agentId);
        address agentOwner = identity.ownerOf(agentId);
        if (msg.sender == provider || msg.sender == agentOwner) revert SharedOwner();

        // A provider must never judge its own work (known ERC-8183 attack).
        if (evaluator != address(0) && (evaluator == provider || evaluator == agentOwner)) revert SharedOwner();
        EvaluatorKind kind;
        if (evaluator == address(0)) {
            kind = EvaluatorKind.Pool;
            evaluator = _pickEvaluator(provider, agentOwner, msg.sender);
        } else if (evaluator == msg.sender) {
            kind = EvaluatorKind.Buyer;
        } else if (isContractEvaluator[evaluator]) {
            kind = EvaluatorKind.Contract;
        } else {
            if (!inPool[evaluator]) revert NotPoolEvaluator();
            kind = EvaluatorKind.Pool;
        }
        if (budget > poolThreshold && kind != EvaluatorKind.Pool) revert PoolEvaluatorRequired();

        jobId = _jobs.length;
        Job storage j = _jobs.push();
        j.client = msg.sender;
        j.provider = provider;
        j.evaluator = evaluator;
        j.agentId = agentId;
        j.budget = budget;
        j.createdAt = uint64(block.timestamp);
        j.expiredAt = expiredAt;
        j.kind = kind;
        j.description = description;
        j.bondOwner = agentOwner;
        emit JobCreated(jobId, agentId, msg.sender, provider, evaluator, uint8(kind), budget, expiredAt, description);
    }

    /// @notice Provider quotes a budget for an Open job.
    function setBudget(uint256 jobId, uint256 budget) external {
        Job storage j = _jobs[jobId];
        if (msg.sender != j.provider) revert NotAuthorized();
        if (j.status != Status.Open) revert InvalidStatus(j.status);
        if (budget > budgetCap) revert BudgetAboveCap(budgetCap);
        if (budget > poolThreshold && j.kind != EvaluatorKind.Pool) revert PoolEvaluatorRequired();
        j.budget = budget;
        emit BudgetSet(jobId, budget);
    }

    /// @notice Client funds escrow. `expectedBudget` guards against a last-second re-quote.
    function fund(uint256 jobId, uint256 expectedBudget) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (msg.sender != j.client) revert NotAuthorized();
        if (j.status != Status.Open) revert InvalidStatus(j.status);
        if (j.budget != expectedBudget || j.budget == 0) revert BudgetMismatch(j.budget);

        uint256 evalFee = j.kind == EvaluatorKind.Pool ? (j.budget * evaluatorFeeBps) / 10_000 : 0;
        uint256 bond = (j.budget * bondBps) / 10_000;
        bonds.lock(j.bondOwner, bond);
        j.bondLocked = bond;
        j.evaluatorFee = evalFee;
        j.status = Status.Funded;
        j.fundedAt = uint64(block.timestamp);
        openJobCount[j.agentId] += 1;
        nrx.safeTransferFrom(msg.sender, address(this), j.budget + evalFee);
        emit JobFunded(jobId, msg.sender, j.budget, evalFee);
    }

    function submit(uint256 jobId, bytes32 deliverable) external {
        Job storage j = _jobs[jobId];
        if (msg.sender != j.provider) revert NotAuthorized();
        if (j.status != Status.Funded) revert InvalidStatus(j.status);
        j.deliverable = deliverable;
        j.status = Status.Submitted;
        j.submittedAt = uint64(block.timestamp);
        emit JobSubmitted(jobId, msg.sender, deliverable);
    }

    function complete(uint256 jobId, bytes32 reason) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (msg.sender != j.evaluator) revert NotAuthorized();
        if (j.status != Status.Submitted) revert InvalidStatus(j.status);
        j.status = Status.Completed;
        openJobCount[j.agentId] -= 1;
        bonds.unlock(j.bondOwner, j.bondLocked);
        isPaidClient[j.agentId][j.client] = true;

        uint256 fee = feeFor(j.bondOwner, j.budget);
        uint256 toProvider = j.budget - fee;
        nrx.safeTransfer(j.provider, toProvider);
        if (fee > 0) nrx.safeTransfer(treasury, fee);
        if (j.evaluatorFee > 0) nrx.safeTransfer(j.evaluator, j.evaluatorFee);
        emit JobCompleted(jobId, msg.sender, toProvider, fee, reason);
    }

    /// @notice Client may cancel an unfunded job; the evaluator may reject a funded or
    ///         submitted one. Rejection by a non-buyer evaluator slashes the seller bond.
    function reject(uint256 jobId, bytes32 reason) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status == Status.Open) {
            if (msg.sender != j.client) revert NotAuthorized();
            j.status = Status.Rejected;
            emit JobRejected(jobId, msg.sender, 0, 0, reason);
            return;
        }
        if (msg.sender != j.evaluator) revert NotAuthorized();
        if (j.status != Status.Funded && j.status != Status.Submitted) revert InvalidStatus(j.status);
        j.status = Status.Rejected;
        openJobCount[j.agentId] -= 1;
        bonds.unlock(j.bondOwner, j.bondLocked);

        uint256 slashed;
        // A buyer-evaluator is cheap but open to unfair rejection, so it refunds without slashing.
        if (j.kind != EvaluatorKind.Buyer) {
            slashed = bonds.slash(j.bondOwner, j.client, (j.budget * rejectPenaltyBps) / 10_000);
        }
        nrx.safeTransfer(j.client, j.budget);
        if (j.evaluatorFee > 0) nrx.safeTransfer(j.evaluator, j.evaluatorFee);
        emit JobRejected(jobId, msg.sender, j.budget, slashed, reason);
    }

    /// @notice After the deadline anyone can refund the client. A job that was never
    ///         delivered also slashes the seller bond.
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (block.timestamp < j.expiredAt) revert NotExpired();
        if (j.status != Status.Funded && j.status != Status.Submitted) revert InvalidStatus(j.status);
        bool delivered = j.status == Status.Submitted;
        j.status = Status.Expired;
        openJobCount[j.agentId] -= 1;
        bonds.unlock(j.bondOwner, j.bondLocked);
        uint256 slashed;
        if (!delivered) slashed = bonds.slash(j.bondOwner, j.client, (j.budget * rejectPenaltyBps) / 10_000);
        uint256 refund = j.budget + j.evaluatorFee;
        nrx.safeTransfer(j.client, refund);
        emit JobExpired(jobId, refund, slashed);
    }

    // ---------------------------------------------------------------- evaluators

    /// @notice Join the evaluator pool by holding at least `minEvaluatorBond` in SellerBond.
    function joinEvaluatorPool() external {
        if (bonds.freeValue(msg.sender) < minEvaluatorBond) revert NotPoolEvaluator();
        if (!inPool[msg.sender]) {
            inPool[msg.sender] = true;
            evaluatorPool.push(msg.sender);
            emit EvaluatorRegistered(msg.sender, false);
        }
    }

    function setContractEvaluator(address evaluator, bool status) external onlyRole(DEFAULT_ADMIN_ROLE) {
        isContractEvaluator[evaluator] = status;
        emit EvaluatorRegistered(evaluator, true);
    }

    function _pickEvaluator(address provider, address agentOwner, address client) internal view returns (address) {
        uint256 n = evaluatorPool.length;
        if (n == 0) revert PoolEvaluatorRequired();
        uint256 seed = uint256(keccak256(abi.encode(block.prevrandao, block.timestamp, _jobs.length, client)));
        for (uint256 i; i < n; ++i) {
            address e = evaluatorPool[(seed + i) % n];
            if (e == provider || e == agentOwner || e == client) continue;
            if (bonds.freeValue(e) < minEvaluatorBond) continue;
            return e;
        }
        revert PoolEvaluatorRequired();
    }

    // ---------------------------------------------------------------- admin

    function setFees(uint256 platformBps, uint256 evaluatorBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(platformBps <= 1_000 && evaluatorBps <= 500, "fee");
        platformFeeBps = platformBps;
        evaluatorFeeBps = evaluatorBps;
    }

    function setLimits(uint256 cap, uint256 threshold, uint256 bondBps_, uint256 penaltyBps, uint256 minEvalBond)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        budgetCap = cap;
        poolThreshold = threshold;
        bondBps = bondBps_;
        rejectPenaltyBps = penaltyBps;
        minEvaluatorBond = minEvalBond;
    }

    /// @notice Launch incentive: fee-free period for early verified sellers.
    function setFeeWaiver(address seller, uint64 until) external onlyRole(DEFAULT_ADMIN_ROLE) {
        feeWaiverUntil[seller] = until;
        emit FeeWaiverSet(seller, until);
    }

    function setTreasury(address t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        treasury = t;
    }
}
