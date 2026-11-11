// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Payload} from "@crossecute/protocol/messaging/Payload.sol";
import {ChainKey} from "@crossecute/protocol/addressing/ChainKey.sol";
import {Erc7930} from "@crossecute/protocol/addressing/Erc7930.sol";

/// @notice The transceiver views `CrossecuteScript` reads, with one fixed prediction.
contract MockTransceiver {
    address public predicted;
    mapping(bytes32 => bool) public reportsReceiver;

    constructor(address predicted_) {
        predicted = predicted_;
    }

    function setReports(bytes32 key, bool reports) external {
        reportsReceiver[key] = reports;
    }

    function predictReceiver(bytes32, address, bytes32) external view returns (bytes memory) {
        return abi.encodePacked(predicted);
    }
}

/// @notice The transmitter entry points `CrossecuteScript` calls, with the protocol's encoders
///         and checks reduced to what a plan depends on: owner-only, funded from its balance,
///         bootstrap before send, recipient equal to the recorded receiver.
contract MockTransmitter {
    uint256 public constant MESSAGE_FEE = 0.01 ether;
    uint256 public constant BOOTSTRAP_FEE = 0.05 ether;
    address public constant FEE_SINK = address(0xFEE);

    address public owner;
    address public transceiver;
    address public deployer;
    bytes32 public conduitSalt = keccak256("salt");
    mapping(bytes32 => bytes) public counterparts;
    bytes[] public sentPayloads;

    error NotOwner();
    error NotBootstrapped();
    error AlreadyBootstrapped();
    error WrongRecipient();
    error InsufficientBalance(uint256 fee, uint256 balance);

    constructor(address owner_, address transceiver_) {
        owner = owner_;
        deployer = owner_;
        transceiver = transceiver_;
    }

    receive() external payable {}

    function isBootstrapped(bytes32 key) public view returns (bool) {
        return counterparts[key].length != 0;
    }

    function destinationReceiverOn(bytes32 key) external view returns (bytes memory) {
        return counterparts[key];
    }

    function recipientOn(uint256 chainId) public view returns (bytes memory) {
        bytes memory raw = counterparts[ChainKey.forEvm(chainId)];
        if (raw.length == 0) revert NotBootstrapped();
        return Erc7930.encodeEvm(chainId, address(bytes20(raw)));
    }

    function quoteMessage(bytes calldata, bytes calldata, bytes[] calldata) external pure returns (uint256) {
        return MESSAGE_FEE;
    }

    function quoteBootstrap(bytes calldata, bytes[] calldata) external pure returns (uint256) {
        return BOOTSTRAP_FEE;
    }

    function sendMessage(bytes calldata recipient, bytes calldata payload, bytes[] calldata)
        external
        payable
        returns (bytes32)
    {
        if (msg.sender != owner) revert NotOwner();
        Erc7930.Interop memory io = Erc7930.parseStrict(recipient);
        bytes32 key = ChainKey.fromParsed(io);
        if (!isBootstrapped(key)) revert NotBootstrapped();
        if (keccak256(io.addr) != keccak256(counterparts[key])) revert WrongRecipient();
        Payload.decodeCalls(payload);
        _pay(MESSAGE_FEE);
        sentPayloads.push(payload);
        return bytes32(0);
    }

    function bootstrap(bytes calldata payload, bytes[] calldata) external payable {
        if (msg.sender != owner) revert NotOwner();
        (bytes memory chainIdentifier, bytes memory body) = Payload.decodeBootstrap(payload);
        bytes32 key = ChainKey.fromIdentifier(chainIdentifier);
        if (isBootstrapped(key)) revert AlreadyBootstrapped();
        Payload.decodeCallsFromMemory(body);
        _pay(BOOTSTRAP_FEE);
        counterparts[key] = MockTransceiver(transceiver).predictReceiver(key, deployer, conduitSalt);
        sentPayloads.push(payload);
    }

    function _pay(uint256 fee) private {
        if (address(this).balance < fee) revert InsufficientBalance(fee, address(this).balance);
        payable(FEE_SINK).transfer(fee);
    }
}

/// @notice A destination target that records who called it.
contract Counter {
    address public lastCaller;
    uint256 public count;
    uint256 public received;

    error Refused();

    function bump() external payable {
        lastCaller = msg.sender;
        count++;
        received += msg.value;
    }

    function refuse() external pure {
        revert Refused();
    }
}
