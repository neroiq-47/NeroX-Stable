// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Same interface as the Chainalysis on-chain sanctions oracle (`isSanctioned`).
///         The demo chain seeds one sanctioned address so the screening gate can be seen.
contract MockSanctionsOracle {
    address public immutable owner;
    mapping(address => bool) private _sanctioned;

    event SanctionedAddressesAdded(address[] addrs);
    event SanctionedAddressesRemoved(address[] addrs);

    constructor() {
        owner = msg.sender;
    }

    function isSanctioned(address addr) external view returns (bool) {
        return _sanctioned[addr];
    }

    function addToSanctionsList(address[] calldata addrs) external {
        require(msg.sender == owner, "owner");
        for (uint256 i; i < addrs.length; ++i) _sanctioned[addrs[i]] = true;
        emit SanctionedAddressesAdded(addrs);
    }

    function removeFromSanctionsList(address[] calldata addrs) external {
        require(msg.sender == owner, "owner");
        for (uint256 i; i < addrs.length; ++i) _sanctioned[addrs[i]] = false;
        emit SanctionedAddressesRemoved(addrs);
    }
}
