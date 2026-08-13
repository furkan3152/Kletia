// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

contract KletiaArcBatchPay is ERC2771Context {
    address public owner;

    uint256 public maxRecipientsPerBatch;

    uint256 public nextBatchId;

    struct BatchRecord {
        uint256 id;
        address sender;
        uint256 totalAmount;
        uint256 recipientCount;
        string memo;
        uint256 timestamp;
    }

    mapping(uint256 => BatchRecord) public batches;

    mapping(address => uint256[]) private _senderBatches;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    event BatchPayment(
        address indexed sender,
        uint256 totalAmount,
        uint256 recipientCount,
        uint256 indexed batchId,
        string memo
    );
    event MaxRecipientsUpdated(uint256 oldMax, uint256 newMax);
    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    modifier onlyOwner() {
        require(
            _msgSender() == owner,
            "KletiaArcBatchPay: caller is not the owner"
        );
        _;
    }

    modifier nonReentrant() {
        require(_status != _ENTERED, "KletiaArcBatchPay: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    constructor(
        address trustedForwarder,
        uint256 _maxRecipients
    ) ERC2771Context(trustedForwarder) {
        require(
            _maxRecipients > 0,
            "KletiaArcBatchPay: max recipients must be > 0"
        );

        owner = _msgSender();
        maxRecipientsPerBatch = _maxRecipients;
        _status = _NOT_ENTERED;

        emit OwnershipTransferred(address(0), _msgSender());
        emit MaxRecipientsUpdated(0, _maxRecipients);
    }

    function batchPay(
        address[] calldata recipients,
        uint256[] calldata amounts,
        string calldata memo
    ) external payable nonReentrant returns (uint256 batchId) {
        uint256 count = recipients.length;
        require(count > 0, "KletiaArcBatchPay: empty recipients");
        require(
            count == amounts.length,
            "KletiaArcBatchPay: array length mismatch"
        );
        require(
            count <= maxRecipientsPerBatch,
            "KletiaArcBatchPay: exceeds max recipients"
        );
        require(bytes(memo).length <= 256, "KletiaArcBatchPay: memo too long");

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < count;) {
            require(
                recipients[i] != address(0),
                "KletiaArcBatchPay: invalid recipient"
            );
            require(amounts[i] > 0, "KletiaArcBatchPay: amount must be > 0");
            totalAmount += amounts[i];
            unchecked {
                ++i;
            }
        }

        require(
            msg.value == totalAmount,
            "KletiaArcBatchPay: msg.value does not match total amount"
        );

        for (uint256 i = 0; i < count;) {
            (bool success, ) = payable(recipients[i]).call{value: amounts[i]}(
                ""
            );
            require(success, "KletiaArcBatchPay: Native USDC transfer failed");
            unchecked {
                ++i;
            }
        }

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

    function getBatch(
        uint256 batchId
    ) external view returns (BatchRecord memory) {
        require(
            batchId < nextBatchId,
            "KletiaArcBatchPay: batch does not exist"
        );
        return batches[batchId];
    }

    function getBatchIdsBySender(
        address sender
    ) external view returns (uint256[] memory) {
        return _senderBatches[sender];
    }

    function totalBatches() external view returns (uint256) {
        return nextBatchId;
    }

    function setMaxRecipients(uint256 newMax) external onlyOwner {
        require(newMax > 0, "KletiaArcBatchPay: max must be > 0");
        uint256 oldMax = maxRecipientsPerBatch;
        maxRecipientsPerBatch = newMax;
        emit MaxRecipientsUpdated(oldMax, newMax);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "KletiaArcBatchPay: invalid new owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
