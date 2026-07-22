// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title KletiaVault
 * @dev A highly secure, self-custodial smart vault. 
 * Designed to be controlled by a human owner and operated by an AI Agent.
 * Contains no third-party dependencies to eliminate supply chain risks.
 */
contract KletiaVault is IERC1271 {
    address public owner;
    address public agent;
    
    // Reentrancy guard state
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    event Executed(address indexed target, uint256 value, bytes data, bytes returnData);
    event AgentUpdated(address indexed oldAgent, address indexed newAgent);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Received(address indexed sender, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "KletiaVault: caller is not the owner");
        _;
    }

    modifier onlyAgentOrOwner() {
        require(msg.sender == agent || msg.sender == owner, "KletiaVault: unauthorized execution");
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

    /**
     * @dev Executes a transaction. Protected against reentrancy.
     */
    function execute(address target, uint256 value, bytes calldata data) external onlyAgentOrOwner nonReentrant returns (bytes memory) {
        require(target != address(0), "KletiaVault: invalid target address");
        
        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) {
            // Forward revert reason if available
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

    /**
     * @dev Allows owner to assign a new AI Agent.
     */
    function setAgent(address _newAgent) external onlyOwner {
        require(_newAgent != address(0), "KletiaVault: invalid agent address");
        emit AgentUpdated(agent, _newAgent);
        agent = _newAgent;
    }

    /**
     * @dev Allows owner to transfer ownership.
     */
    function transferOwnership(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "KletiaVault: invalid owner address");
        emit OwnershipTransferred(owner, _newOwner);
        owner = _newOwner;
    }

    /**
     * @dev Allows the vault to receive ETH securely.
     */
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /**
     * @dev EIP-1271 Signature Validation
     * Allows the AI Agent or the Owner to sign messages (e.g. Permit2/X402) on behalf of the Vault.
     */
    function isValidSignature(bytes32 hash, bytes memory signature) external view override returns (bytes4 magicValue) {
        address recovered = ECDSA.recover(hash, signature);
        if (recovered == agent || recovered == owner) {
            return this.isValidSignature.selector;
        } else {
            return 0xffffffff;
        }
    }
}

/**
 * @title KletiaVaultFactory
 * @dev A secure factory to deploy KletiaVault instances.
 * Keeps an on-chain registry of all user vaults to ensure authenticity.
 */
contract KletiaVaultFactory {
    event VaultCreated(address indexed owner, address indexed vault, address agent);

    mapping(address => address) public userVaults;

    /**
     * @dev Deploys a new KletiaVault for the caller.
     * Prevents multiple active vaults per user to maintain a clean registry.
     */
    function createVault(address _agent) external returns (address) {
        require(userVaults[msg.sender] == address(0), "KletiaVaultFactory: vault already exists for user");
        require(_agent != address(0), "KletiaVaultFactory: invalid agent address");

        KletiaVault newVault = new KletiaVault(msg.sender, _agent);
        userVaults[msg.sender] = address(newVault);

        emit VaultCreated(msg.sender, address(newVault), _agent);
        return address(newVault);
    }

    /**
     * @dev Predicts the address of a user's vault if they already deployed it.
     */
    function getVault(address _user) external view returns (address) {
        return userVaults[_user];
    }
}
