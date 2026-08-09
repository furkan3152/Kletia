
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

contract KletiaArcMemoTransfer is ERC2771Context {

    address public owner;

    uint256 public nextTransferId;

    struct TransferRecord {
        uint256 id;
        address from;
        address to;
        uint256 amount;
        string memo;
        uint256 timestamp;
    }

    mapping(uint256 => TransferRecord) public transfers;

    mapping(address => uint256[]) private _sentTransfers;

    mapping(address => uint256[]) private _receivedTransfers;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    event MemoTransfer(
        address indexed from,
        address indexed to,
        uint256 amount,
        string memo,
        uint256 indexed transferId
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(_msgSender() == owner, "KletiaArcMemoTransfer: caller is not the owner");
        _;
    }

    modifier nonReentrant() {
        require(_status != _ENTERED, "KletiaArcMemoTransfer: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    constructor(address trustedForwarder) ERC2771Context(trustedForwarder) {
        owner = _msgSender();
        _status = _NOT_ENTERED;
        emit OwnershipTransferred(address(0), _msgSender());
    }

        function transferWithMemo(
        address to,
        string calldata memo
    ) external payable nonReentrant returns (uint256 transferId) {
        uint256 amount = msg.value;
        require(to != address(0), "KletiaArcMemoTransfer: invalid recipient");
        require(to != _msgSender(), "KletiaArcMemoTransfer: cannot transfer to self");
        require(amount > 0, "KletiaArcMemoTransfer: amount must be > 0");
        require(bytes(memo).length > 0, "KletiaArcMemoTransfer: memo cannot be empty");
        require(bytes(memo).length <= 256, "KletiaArcMemoTransfer: memo too long");

        transferId = nextTransferId++;

        (bool success, ) = payable(to).call{value: amount}("");
        require(success, "KletiaArcMemoTransfer: Native USDC transfer failed");

        transfers[transferId] = TransferRecord({
            id: transferId,
            from: _msgSender(),
            to: to,
            amount: amount,
            memo: memo,
            timestamp: block.timestamp
        });

        _sentTransfers[_msgSender()].push(transferId);
        _receivedTransfers[to].push(transferId);

        emit MemoTransfer(_msgSender(), to, amount, memo, transferId);
    }

        function getTransfer(uint256 transferId) external view returns (TransferRecord memory) {
        require(transferId < nextTransferId, "KletiaArcMemoTransfer: transfer does not exist");
        return transfers[transferId];
    }

        function getMemo(uint256 transferId) external view returns (string memory) {
        require(transferId < nextTransferId, "KletiaArcMemoTransfer: transfer does not exist");
        return transfers[transferId].memo;
    }

        function getSentTransferIds(address addr) external view returns (uint256[] memory) {
        return _sentTransfers[addr];
    }

        function getReceivedTransferIds(address addr) external view returns (uint256[] memory) {
        return _receivedTransfers[addr];
    }

        function sentTransferCount(address addr) external view returns (uint256) {
        return _sentTransfers[addr].length;
    }

        function receivedTransferCount(address addr) external view returns (uint256) {
        return _receivedTransfers[addr].length;
    }

        function totalTransfers() external view returns (uint256) {
        return nextTransferId;
    }

        function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "KletiaArcMemoTransfer: invalid new owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
