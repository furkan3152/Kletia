// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract KletiaVault is IERC1271 {
    address public owner;
    address public agent;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    event Executed(
        address indexed target,
        uint256 value,
        bytes data,
        bytes returnData
    );
    event AgentUpdated(address indexed oldAgent, address indexed newAgent);
    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );
    event Received(address indexed sender, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "KletiaVault: caller is not the owner");
        _;
    }

    modifier onlyAgentOrOwner() {
        require(
            msg.sender == agent || msg.sender == owner,
            "KletiaVault: unauthorized execution"
        );
        _;
    }

    modifier nonReentrant() {
        require(_status != _ENTERED, "KletiaVault: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    constructor(address _owner, address _agent) {
        require(_owner != address(0), "KletiaVault: invalid owner address");
        require(_agent != address(0), "KletiaVault: invalid agent address");
        owner = _owner;
        agent = _agent;
        _status = _NOT_ENTERED;
        emit OwnershipTransferred(address(0), _owner);
        emit AgentUpdated(address(0), _agent);
    }

    function execute(
        address target,
        uint256 value,
        bytes calldata data
    ) external onlyAgentOrOwner nonReentrant returns (bytes memory) {
        require(target != address(0), "KletiaVault: invalid target address");

        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) {
            if (result.length > 0) {
                assembly {
                    let returndata_size := mload(result)
                    revert(add(32, result), returndata_size)
                }
            } else {
                revert("KletiaVault: transaction execution failed");
            }
        }

        emit Executed(target, value, data, result);
        return result;
    }

    function setAgent(address _newAgent) external onlyOwner {
        require(_newAgent != address(0), "KletiaVault: invalid agent address");
        emit AgentUpdated(agent, _newAgent);
        agent = _newAgent;
    }

    function transferOwnership(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "KletiaVault: invalid owner address");
        emit OwnershipTransferred(owner, _newOwner);
        owner = _newOwner;
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    function isValidSignature(
        bytes32 hash,
        bytes memory signature
    ) external view override returns (bytes4 magicValue) {
        address recovered = ECDSA.recover(hash, signature);
        if (recovered == agent || recovered == owner) {
            return this.isValidSignature.selector;
        } else {
            return 0xffffffff;
        }
    }
}

contract KletiaVaultFactory {
    event VaultCreated(
        address indexed owner,
        address indexed vault,
        address agent
    );

    mapping(address => address) public userVaults;

    function createVault(address _agent) external returns (address) {
        require(
            userVaults[msg.sender] == address(0),
            "KletiaVaultFactory: vault already exists for user"
        );
        require(
            _agent != address(0),
            "KletiaVaultFactory: invalid agent address"
        );

        KletiaVault newVault = new KletiaVault(msg.sender, _agent);
        userVaults[msg.sender] = address(newVault);

        emit VaultCreated(msg.sender, address(newVault), _agent);
        return address(newVault);
    }

    function getVault(address _user) external view returns (address) {
        return userVaults[_user];
    }
}
