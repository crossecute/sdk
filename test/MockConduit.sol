// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Payload} from "@crossecute/protocol/messaging/Payload.sol";
import {ChainKey} from "@crossecute/protocol/addressing/ChainKey.sol";
import {Erc7930} from "@crossecute/protocol/addressing/Erc7930.sol";

/// @notice The transceiver views `CrossecuteScript` reads, with fixed predictions.
contract MockTransceiver {
    address public predicted;
    address public predictedTransmitter;
    bytes32 public messageProvider = keccak256("provider");
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

    function setPredictedTransmitter(address at) external {
        predictedTransmitter = at;
    }

    function predictTransmitter(address, bytes32) external view returns (address) {
        return predictedTransmitter;
    }
}

/// @notice A registry that places one transceiver for one provider.
contract MockRegistry {
    address public transceiver;
    bytes32 public provider;

    constructor(address transceiver_, bytes32 provider_) {
        transceiver = transceiver_;
        provider = provider_;
    }

    function predictTransceiver(bytes32, bytes32 messageProvider) external view returns (address) {
        return messageProvider == provider ? transceiver : address(0xBAD);
    }
}

/// @notice Safe 1.4.1's `VERSION`, `nonce` and `getTransactionHash`, the hash written from
///         Safe's own constants rather than the SDK's library.
contract MockSafe {
    bytes32 private constant DOMAIN_SEPARATOR_TYPEHASH =
        0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218;
    bytes32 private constant SAFE_TX_TYPEHASH = 0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8;

    string public constant VERSION = "1.4.1";
    uint256 public nonce = 7;

    receive() external payable {}

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
        uint256 nonce_
    ) external view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, block.chainid, this));
        bytes32 safeTx = keccak256(
            abi.encode(
                SAFE_TX_TYPEHASH,
                to,
                value,
                keccak256(data),
                operation,
                safeTxGas,
                baseGas,
                gasPrice,
                gasToken,
                refundReceiver,
                nonce_
            )
        );
        return keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), domain, safeTx));
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
