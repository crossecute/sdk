// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {PlanJson} from "./PlanJson.sol";
import {SafeTx} from "./Types.sol";
import {ISignedTransmitter} from "./vendor/protocol135/ISignedTransmitter.sol";

interface IAuthorityRelayMulticall {
    struct Call3Value {
        address target;
        bool allowFailure;
        uint256 value;
        bytes callData;
    }

    function aggregate3Value(Call3Value[] calldata calls) external payable;
}

interface IAuthorityRelayReceiver {
    function selection() external view returns (bytes32 updateHead, bytes32 authorityHash);
}

abstract contract AuthorityRelayScript is Script {
    struct Relay {
        uint256 sourceChainId;
        address safe;
        uint256 nonce;
        address transmitter;
        uint256 destinationChainId;
        uint256 destinationBlock;
        address receiver;
        bytes32 previousHead;
        bytes32 previousAuthorityHash;
        bytes recipient;
        bytes submission;
        bytes[] attributes;
    }

    error WrongRelayChain(uint256 expected, uint256 actual);
    error ReceiverSelectionChanged();

    function _writeAuthorityRelay(Relay memory relay, string memory destinationRpc, string memory output) internal {
        _checkAuthorityRelaySelection(relay, destinationRpc);
        SafeTx memory proposal = _authorityRelayTx(relay, relay.safe);
        vm.writeFile(output, PlanJson.safeTxTypedData(relay.sourceChainId, relay.safe, proposal));
    }

    function _writeAuthorityRelayBatch(
        Relay[] memory relays,
        string[] memory destinationRpcs,
        address multicall,
        string memory output
    ) internal {
        Relay memory first = relays[0];
        uint256 total;
        IAuthorityRelayMulticall.Call3Value[] memory calls = new IAuthorityRelayMulticall.Call3Value[](relays.length);
        for (uint256 i; i < relays.length; ++i) {
            _checkAuthorityRelaySelection(relays[i], destinationRpcs[i]);
            SafeTx memory relayTx = _authorityRelayTx(relays[i], multicall);
            total += relayTx.value;
            calls[i] = IAuthorityRelayMulticall.Call3Value(relayTx.to, false, relayTx.value, relayTx.data);
        }
        bytes memory data = abi.encodeCall(IAuthorityRelayMulticall.aggregate3Value, (calls));
        SafeTx memory proposal = _safeRelayProposal(multicall, first.nonce, total, data);
        vm.writeFile(output, PlanJson.safeTxTypedData(first.sourceChainId, first.safe, proposal));
    }

    function _checkAuthorityRelaySelection(Relay memory relay, string memory destinationRpc) private {
        if (block.chainid != relay.sourceChainId) revert WrongRelayChain(relay.sourceChainId, block.chainid);
        uint256 sourceFork = vm.activeFork();
        vm.selectFork(vm.createFork(destinationRpc, relay.destinationBlock));
        if (block.chainid != relay.destinationChainId) revert WrongRelayChain(relay.destinationChainId, block.chainid);
        (bytes32 head, bytes32 authorityHash) = IAuthorityRelayReceiver(relay.receiver).selection();
        if (head != relay.previousHead || authorityHash != relay.previousAuthorityHash) {
            revert ReceiverSelectionChanged();
        }
        vm.selectFork(sourceFork);
    }

    function _authorityRelayTx(Relay memory relay, address quoteAccount) internal returns (SafeTx memory) {
        vm.prank(quoteAccount);
        uint256 fee =
            ISignedTransmitter(relay.transmitter).quoteAuthority(relay.recipient, relay.submission, relay.attributes);
        bytes memory data =
            abi.encodeCall(ISignedTransmitter.relayAuthority, (relay.recipient, relay.submission, relay.attributes));
        return _safeRelayProposal(relay.transmitter, relay.nonce, fee, data);
    }

    function _safeRelayProposal(address to, uint256 nonce, uint256 value, bytes memory data)
        private
        pure
        returns (SafeTx memory)
    {
        return SafeTx({
            to: to,
            value: value,
            data: data,
            operation: 0,
            safeTxGas: 0,
            baseGas: 0,
            gasPrice: 0,
            gasToken: address(0),
            refundReceiver: address(0),
            nonce: nonce
        });
    }
}
