// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeTx} from "./Types.sol";

/// @notice Safe's EIP-712 hashes for Safe 1.3.0 and later, whose domain is the chain id and the
///         Safe's address.
library SafeTxHash {
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(uint256 chainId,address verifyingContract)");
    bytes32 internal constant SAFE_TX_TYPEHASH = keccak256(
        "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"
    );

    function domainSeparator(uint256 chainId, address safe) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, chainId, safe));
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
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(chainId, safe), structHash(t)));
    }
}
