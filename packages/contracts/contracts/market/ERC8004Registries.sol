// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title IdentityRegistry (ERC-8004, local deployment)
/// @notice Each agent is an ERC-721 token whose URI points to its registration file
///         (endpoints, A2A card, MCP server, x402 prices). The agent wallet — where it gets
///         paid — is set with a signature from that wallet, so a listing cannot claim
///         someone else's endpoint or payout address.
/// @dev Demo chains deploy their own copy. On Base/Ethereum/BSC NeroX pins the canonical
///      ERC-8004 deployments instead of forking.
contract IdentityRegistry is ERC721URIStorage, EIP712 {
    bytes32 public constant SET_AGENT_WALLET_TYPEHASH =
        keccak256("SetAgentWallet(uint256 agentId,address newWallet,uint256 deadline)");

    struct MetadataEntry {
        string key;
        bytes value;
    }

    uint256 public totalAgents;
    mapping(uint256 => mapping(string => bytes)) private _metadata;
    mapping(uint256 => address) private _agentWallet;

    event Registered(uint256 indexed agentId, string tokenURI, address indexed owner);
    event MetadataSet(uint256 indexed agentId, string indexed indexedKey, string key, bytes value);
    event AgentWalletSet(uint256 indexed agentId, address indexed wallet);
    event UriUpdated(uint256 indexed agentId, string newUri, address indexed updatedBy);

    error NotAgentOwner();
    error SignatureExpired();
    error InvalidWalletSignature();

    constructor() ERC721("ERC-8004 Agent Identity", "AGENT") EIP712("ERC8004IdentityRegistry", "1") {}

    function register(string calldata tokenURI_, MetadataEntry[] calldata metadata) external returns (uint256) {
        return _register(tokenURI_, metadata);
    }

    function register(string calldata tokenURI_) external returns (uint256) {
        return _register(tokenURI_, new MetadataEntry[](0));
    }

    function _register(string calldata tokenURI_, MetadataEntry[] memory metadata) internal returns (uint256 agentId) {
        agentId = ++totalAgents;
        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, tokenURI_);
        _agentWallet[agentId] = msg.sender;
        for (uint256 i; i < metadata.length; ++i) {
            _metadata[agentId][metadata[i].key] = metadata[i].value;
            emit MetadataSet(agentId, metadata[i].key, metadata[i].key, metadata[i].value);
        }
        emit Registered(agentId, tokenURI_, msg.sender);
        emit AgentWalletSet(agentId, msg.sender);
    }

    function setAgentURI(uint256 agentId, string calldata newUri) external {
        if (ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        _setTokenURI(agentId, newUri);
        emit UriUpdated(agentId, newUri, msg.sender);
    }

    function setMetadata(uint256 agentId, string calldata key, bytes calldata value) external {
        if (ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        _metadata[agentId][key] = value;
        emit MetadataSet(agentId, key, key, value);
    }

    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory) {
        return _metadata[agentId][key];
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        _requireOwned(agentId);
        return _agentWallet[agentId];
    }

    /// @notice Point the agent's payouts at `newWallet`; `newWallet` must sign the change.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external {
        if (ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(SET_AGENT_WALLET_TYPEHASH, agentId, newWallet, deadline)));
        if (!SignatureChecker.isValidSignatureNow(newWallet, digest, signature)) revert InvalidWalletSignature();
        _agentWallet[agentId] = newWallet;
        emit AgentWalletSet(agentId, newWallet);
    }

    /// @dev On transfer the payout wallet moves with ownership: it resets to the new owner,
    ///      who can then point it elsewhere with a fresh signature.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0)) {
            _agentWallet[tokenId] = to;
            emit AgentWalletSet(tokenId, to);
        }
    }
}

/// @title ReputationRegistry (ERC-8004, local deployment)
/// @notice Feedback is written by the client wallet. Anyone can write — the registry expects
///         sybil inflation — so readers filter by reviewer. NeroX ranks by paid reviewers only.
contract ReputationRegistry {
    struct Feedback {
        uint8 score; // 0–100
        bytes32 tag1;
        bytes32 tag2;
        bool isRevoked;
    }

    IdentityRegistry public immutable identityRegistry;
    mapping(uint256 => mapping(address => Feedback[])) private _feedback;
    mapping(uint256 => address[]) private _clients;
    mapping(uint256 => mapping(address => bool)) private _isClient;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint8 score,
        bytes32 indexed tag1,
        bytes32 tag2,
        string fileuri,
        bytes32 filehash
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);

    error SelfFeedback();
    error BadScore();

    constructor(IdentityRegistry identityRegistry_) {
        identityRegistry = identityRegistry_;
    }

    function giveFeedback(
        uint256 agentId,
        uint8 score,
        bytes32 tag1,
        bytes32 tag2,
        string calldata fileuri,
        bytes32 filehash
    ) external {
        if (score > 100) revert BadScore();
        if (identityRegistry.ownerOf(agentId) == msg.sender) revert SelfFeedback();
        _feedback[agentId][msg.sender].push(Feedback(score, tag1, tag2, false));
        if (!_isClient[agentId][msg.sender]) {
            _isClient[agentId][msg.sender] = true;
            _clients[agentId].push(msg.sender);
        }
        emit NewFeedback(agentId, msg.sender, score, tag1, tag2, fileuri, filehash);
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        _feedback[agentId][msg.sender][feedbackIndex].isRevoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _clients[agentId];
    }

    function readAllFeedback(uint256 agentId, address client) external view returns (Feedback[] memory) {
        return _feedback[agentId][client];
    }

    /// @notice Count and average score, counting only the given reviewers (pass the
    ///         paid-reviewer set to get a sybil-resistant score).
    function getSummary(uint256 agentId, address[] calldata clientAddresses)
        external
        view
        returns (uint64 count, uint8 averageScore)
    {
        uint256 total;
        for (uint256 i; i < clientAddresses.length; ++i) {
            Feedback[] storage list = _feedback[agentId][clientAddresses[i]];
            for (uint256 j; j < list.length; ++j) {
                if (list[j].isRevoked) continue;
                total += list[j].score;
                ++count;
            }
        }
        averageScore = count == 0 ? 0 : uint8(total / count);
    }
}
