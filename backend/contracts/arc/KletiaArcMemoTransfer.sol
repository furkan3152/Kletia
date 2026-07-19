// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

/**
 * @title KletiaArcMemoTransfer
 * @author Kletia Team
 * @notice Native USDC transfer contract with on-chain memo/reference strings.
 * @dev Every transfer receives a unique auto-incrementing ID and stores a
 *      memo that can be queried later. Transfer history is indexed by both
 *      sender and recipient addresses.
 *
 *      This leverages ARC Network's low-cost storage to keep memo data
 *      on-chain for auditability and compliance.
 *
 *      Chain ID: 311614
 */
contract KletiaArcMemoTransfer is ERC2771Context {
    // ──────────────────────── State ────────────────────────

    address public owner;

    /// @notice Auto-incrementing transfer ID counter.
    uint256 public nextTransferId;

    struct TransferRecord {
        uint256 id;
        address from;
        address to;
        uint256 amount;
        string memo;
        uint256 timestamp;
    }

    /// @notice Transfer ID → full record.
    mapping(uint256 => TransferRecord) public transfers;

    /// @notice Address → list of transfer IDs the address was involved in (as sender).
    mapping(address => uint256[]) private _sentTransfers;

    /// @notice Address → list of transfer IDs the address was involved in (as recipient).
    mapping(address => uint256[]) private _receivedTransfers;

    // Reentrancy guard
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    // ──────────────────────── Events ───────────────────────

    event MemoTransfer(
        address indexed from,
        address indexed to,
        uint256 amount,
        string memo,
        uint256 indexed transferId
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ──────────────────────── Modifiers ────────────────────

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

    // ──────────────────────── Constructor ──────────────────

    constructor(address trustedForwarder) ERC2771Context(trustedForwarder) {
        owner = _msgSender();
        _status = _NOT_ENTERED;
        emit OwnershipTransferred(address(0), _msgSender());
    }

    // ──────────────────────── Core ─────────────────────────

    /**
     * @notice Transfer Native USDC to `to` with an attached memo.
     * @param to        Recipient address.
     * @param memo      Reference string (invoice number, note, etc.).
     * @return transferId The unique ID assigned to this transfer.
     */
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

        // Forward Native USDC to recipient
        (bool success, ) = payable(to).call{value: amount}("");
        require(success, "KletiaArcMemoTransfer: Native USDC transfer failed");

        // Store record
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

    // ──────────────────────── Views ────────────────────────

    /**
     * @notice Get a transfer record by its ID.
     */
    function getTransfer(uint256 transferId) external view returns (TransferRecord memory) {
        require(transferId < nextTransferId, "KletiaArcMemoTransfer: transfer does not exist");
        return transfers[transferId];
    }

    /**
     * @notice Get the memo for a specific transfer.
     */
    function getMemo(uint256 transferId) external view returns (string memory) {
        require(transferId < nextTransferId, "KletiaArcMemoTransfer: transfer does not exist");
        return transfers[transferId].memo;
    }

    /**
     * @notice Get all transfer IDs sent by `addr`.
     */
    function getSentTransferIds(address addr) external view returns (uint256[] memory) {
        return _sentTransfers[addr];
    }

    /**
     * @notice Get all transfer IDs received by `addr`.
     */
    function getReceivedTransferIds(address addr) external view returns (uint256[] memory) {
        return _receivedTransfers[addr];
    }

    /**
     * @notice Get the count of transfers sent by `addr`.
     */
    function sentTransferCount(address addr) external view returns (uint256) {
        return _sentTransfers[addr].length;
    }

    /**
     * @notice Get the count of transfers received by `addr`.
     */
    function receivedTransferCount(address addr) external view returns (uint256) {
        return _receivedTransfers[addr].length;
    }

    /**
     * @notice Get the total number of transfers ever made.
     */
    function totalTransfers() external view returns (uint256) {
        return nextTransferId;
    }

    // ──────────────────────── Admin ────────────────────────

    /**
     * @notice Transfer contract ownership.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "KletiaArcMemoTransfer: invalid new owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
