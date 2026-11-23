// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeTx} from "./Types.sol";
import {SafeHashes} from "@crossecute/protocol/safe-guard/SafeHashes.sol";

/// @notice Safe's EIP-712 hashes for Safe 1.3.0 and later, whose domain is the chain id and the
///         Safe's address.
library SafeTxHash {
    bytes32 internal constant DOMAIN_TYPEHASH = SafeHashes.DOMAIN_SEPARATOR_TYPEHASH;
    bytes32 internal constant SAFE_TX_TYPEHASH = SafeHashes.SAFE_TX_TYPEHASH;

    function domainSeparator(uint256 chainId, address safe) internal pure returns (bytes32) {
        return SafeHashes.domainSeparator(safe, chainId);
    }

    function structHash(SafeTx memory t) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SAFE_TX_TYPEHASH,
                t.to,
                t.value,
                keccak256(t.data),
                t.operation,
                t.safeTxGas,
                t.baseGas,
                t.gasPrice,
                t.gasToken,
                t.refundReceiver,
                t.nonce
            )
        );
    }

    function hash(uint256 chainId, address safe, SafeTx memory t) internal pure returns (bytes32) {
        return SafeHashes.transactionHash(t, safe, chainId);
    }
}
