// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The Safe views a plan reads.
interface ISafe {
    function VERSION() external view returns (string memory);

    function nonce() external view returns (uint256);

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
}
