// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

/**
 * @title KletiaArcBatchPay
 * @author Kletia Team
 * @notice Batch payment contract for distributing Native USDC to multiple recipients
 *         in a single transaction on the ARC Network.
 * @dev Reverts if any of the underlying native transfers revert (e.g. if a 
 *      recipient is blocklisted or is the zero address on ARC). This ensures
 *      atomicity.
 *
 *      Chain ID: 311614
 */
contract KletiaArcBatchPay is ERC2771Context {
    // ──────────────────────── State ────────────────────────

    address public owner;

    /// @notice Maximum number of recipients allowed per batch.
    uint256 public maxRecipientsPerBatch;

    /// @notice Auto-incrementing batch ID counter.
    uint256 public nextBatchId;

    struct BatchRecord {
        uint256 id;
        address sender;
        uint256 totalAmount;
        uint256 recipientCount;
        string memo;
        uint256 timestamp;
    }

    /// @notice Batch ID → record.
    mapping(uint256 => BatchRecord) public batches;

    /// @notice Sender → list of batch IDs.
    mapping(address => uint256[]) private _senderBatches;

    // Reentrancy guard
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    // ──────────────────────── Events ───────────────────────

    event BatchPayment(
        address indexed sender,
        uint256 totalAmount,
        uint256 recipientCount,
        uint256 indexed batchId,
        string memo
    );
    event MaxRecipientsUpdated(uint256 oldMax, uint256 newMax);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ──────────────────────── Modifiers ────────────────────

    modifier onlyOwner() {
        require(_msgSender() == owner, "KletiaArcBatchPay: caller is not the owner");
        _;
    }

    modifier nonReentrant() {
        require(_status != _ENTERED, "KletiaArcBatchPay: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    // ──────────────────────── Constructor ──────────────────

    /**
     * @param _maxRecipients Initial maximum recipients per batch.
     */
    constructor(address trustedForwarder, uint256 _maxRecipients) ERC2771Context(trustedForwarder) {
        require(_maxRecipients > 0, "KletiaArcBatchPay: max recipients must be > 0");

        owner = _msgSender();
        maxRecipientsPerBatch = _maxRecipients;
        _status = _NOT_ENTERED;

        emit OwnershipTransferred(address(0), _msgSender());
        emit MaxRecipientsUpdated(0, _maxRecipients);
    }

    // ──────────────────────── Core ─────────────────────────

    /**
     * @notice Send Native USDC to multiple recipients in one transaction.
     * @param recipients Array of recipient addresses.
     * @param amounts    Array of Native USDC amounts (must match recipients length).
     * @param memo       Optional memo for the entire batch (pass "" for none).
     * @return batchId   The unique ID assigned to this batch.
     */
    function batchPay(
        address[] calldata recipients,
        uint256[] calldata amounts,
        string calldata memo
    ) external payable nonReentrant returns (uint256 batchId) {
        uint256 count = recipients.length;
        require(count > 0, "KletiaArcBatchPay: empty recipients");
        require(count == amounts.length, "KletiaArcBatchPay: array length mismatch");
        require(count <= maxRecipientsPerBatch, "KletiaArcBatchPay: exceeds max recipients");
        require(bytes(memo).length <= 256, "KletiaArcBatchPay: memo too long");

        // Calculate total and validate each entry
        uint256 totalAmount = 0;
        for (uint256 i = 0; i < count; ) {
            require(recipients[i] != address(0), "KletiaArcBatchPay: invalid recipient");
            require(amounts[i] > 0, "KletiaArcBatchPay: amount must be > 0");
            totalAmount += amounts[i];
            unchecked { ++i; }
        }

        require(msg.value == totalAmount, "KletiaArcBatchPay: msg.value does not match total amount");

        // Distribute Native USDC to recipients
        for (uint256 i = 0; i < count; ) {
            (bool success, ) = payable(recipients[i]).call{value: amounts[i]}("");
            require(success, "KletiaArcBatchPay: Native USDC transfer failed");
            unchecked { ++i; }
        }

        // Store batch record
        batchId = nextBatchId++;
        batches[batchId] = BatchRecord({
            id: batchId,
            sender: _msgSender(),
            totalAmount: totalAmount,
            recipientCount: count,
            memo: memo,
            timestamp: block.timestamp
        });
        _senderBatches[_msgSender()].push(batchId);

        emit BatchPayment(_msgSender(), totalAmount, count, batchId, memo);
    }

    // ──────────────────────── Views ────────────────────────

    /**
     * @notice Get a batch record by its ID.
     */
    function getBatch(uint256 batchId) external view returns (BatchRecord memory) {
        require(batchId < nextBatchId, "KletiaArcBatchPay: batch does not exist");
        return batches[batchId];
    }

    /**
     * @notice Get all batch IDs for a sender.
     */
    function getBatchIdsBySender(address sender) external view returns (uint256[] memory) {
        return _senderBatches[sender];
    }

    /**
     * @notice Get total number of batches processed.
     */
    function totalBatches() external view returns (uint256) {
        return nextBatchId;
    }

    // ──────────────────────── Admin ────────────────────────

    /**
     * @notice Update the maximum number of recipients per batch.
     * @param newMax New maximum (must be > 0).
     */
    function setMaxRecipients(uint256 newMax) external onlyOwner {
        require(newMax > 0, "KletiaArcBatchPay: max must be > 0");
        uint256 oldMax = maxRecipientsPerBatch;
        maxRecipientsPerBatch = newMax;
        emit MaxRecipientsUpdated(oldMax, newMax);
    }

    /**
     * @notice Transfer contract ownership.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "KletiaArcBatchPay: invalid new owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
