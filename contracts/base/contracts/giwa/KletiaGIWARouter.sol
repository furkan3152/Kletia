// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

interface IDojangVerifiedAddress {
    function isVerified(address _account) external view returns (bool);
    function getGracePeriod(address _account) external view returns (uint256);
}

interface IUPIDResolver {
    function resolve(string calldata _name) external view returns (address);
}

contract KletiaGIWARouter {
    IDojangVerifiedAddress public dojangRegistry;
    IUPIDResolver public upidResolver;

    event IntentExecuted(address indexed user, string upid, uint256 value, bytes data);

    constructor(address _dojangAddress, address _upidResolverAddress) {
        dojangRegistry = IDojangVerifiedAddress(_dojangAddress);
        upidResolver = IUPIDResolver(_upidResolverAddress);
    }

        function executeVerifiedIntent(string calldata targetUPID, bytes calldata intentData) external payable {

        require(dojangRegistry.isVerified(msg.sender), "Kletia: Sender lacks Dojang Verification");

        address targetAddress = upidResolver.resolve(targetUPID);
        require(targetAddress != address(0), "Kletia: UP-ID resolution failed");

        (bool success, ) = targetAddress.call{value: msg.value}(intentData);
        require(success, "Kletia: Intent execution failed");

        emit IntentExecuted(msg.sender, targetUPID, msg.value, intentData);
    }
}
