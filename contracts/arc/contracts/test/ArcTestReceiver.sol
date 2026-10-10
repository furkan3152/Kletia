// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only native receiver for failed-payment and callback scenarios.
contract ArcTestReceiver {
    bool public rejectPayment;
    address public reentryTarget;
    bytes public reentryData;
    uint256 public reentryValue;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    function setRejectPayment(bool reject) external {
        rejectPayment = reject;
    }

    function setReentry(address target, bytes calldata data, uint256 value) external {
        reentryTarget = target;
        reentryData = data;
        reentryValue = value;
        reentryAttempted = false;
        reentrySucceeded = false;
    }

    function invoke(address target, bytes calldata data) external payable returns (bytes memory result) {
        bool success;
        (success, result) = target.call{value: msg.value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    receive() external payable {
        require(!rejectPayment, "ArcTestReceiver: rejected payment");
        if (reentryTarget != address(0)) {
            reentryAttempted = true;
            (reentrySucceeded, ) = reentryTarget.call{value: reentryValue}(reentryData);
        }
    }
}
