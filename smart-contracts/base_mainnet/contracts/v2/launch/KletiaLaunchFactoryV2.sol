
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract KletiaFixedSupplyTokenV2 is ERC20, ERC20Permit {
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address recipient_
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        _mint(recipient_, totalSupply_);
    }
}

contract KletiaLaunchFactoryV2 is Ownable2Step, ReentrancyGuard {
    uint256 public constant MAX_DEPLOYMENT_FEE = 0.01 ether;
    uint256 public constant MAX_TOKEN_SUPPLY = 1e36;
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_SYMBOL_BYTES = 16;

    bytes32 private constant _SALT_DOMAIN = keccak256("KLETIA_LAUNCH_FACTORY_V2");

    address public treasury;
    address public pendingTreasury;
    uint256 public deploymentFee;
    mapping(address creator => mapping(bytes32 userSalt => address token))
        public tokenForSalt;

    error InvalidAddress();
    error InvalidName();
    error InvalidSymbol();
    error InvalidSupply(uint256 supplied);
    error DeploymentFeeAboveHardCap(uint256 supplied, uint256 maximum);
    error DeploymentFeeExceedsCallerLimit(uint256 currentFee, uint256 callerMaximum);
    error IncorrectNativeValue(uint256 expected, uint256 actual);
    error TokenAlreadyDeployed(address token);
    error CreatorSaltAlreadyUsed(
        address creator,
        bytes32 userSalt,
        address existingToken
    );
    error FeeTransferFailed(address treasury, uint256 amount);
    error UnauthorizedTreasuryAcceptance(address caller, address pending);
    error OwnershipRenunciationDisabled();

    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event TreasuryProposed(address indexed currentTreasury, address indexed pendingTreasury);
    event DeploymentFeeUpdated(uint256 previousFee, uint256 newFee);
    event TokenDeployed(
        address indexed token,
        address indexed creator,
        address indexed recipient,
        bytes32 userSalt,
        bytes32 deploymentSalt,
        uint256 totalSupply,
        uint256 deploymentFee
    );
    event TokenMetadataCommitted(address indexed token, string name, string symbol);

    constructor(address initialOwner, address initialTreasury) Ownable(initialOwner) {
        if (initialTreasury == address(0) || initialTreasury == address(this)) {
            revert InvalidAddress();
        }

        treasury = initialTreasury;
        emit TreasuryUpdated(address(0), initialTreasury);

    }

        function deploymentSalt(address creator, bytes32 userSalt) public pure returns (bytes32) {
        if (creator == address(0)) revert InvalidAddress();
        return keccak256(abi.encode(_SALT_DOMAIN, creator, userSalt));
    }

        function tokenInitCodeHash(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        address recipient_
    ) public pure returns (bytes32) {
        _validateTokenParameters(name_, symbol_, totalSupply_, recipient_);
        return
            keccak256(
                abi.encodePacked(
                    type(KletiaFixedSupplyTokenV2).creationCode,
                    abi.encode(name_, symbol_, totalSupply_, recipient_)
                )
            );
    }

        function predictTokenAddress(
        address creator,
        bytes32 userSalt,
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        address recipient_
    ) public view returns (address predicted) {
        _validateFactoryRecipient(recipient_);
        address existingToken = tokenForSalt[creator][userSalt];
        if (existingToken != address(0)) {
            revert CreatorSaltAlreadyUsed(
                creator,
                userSalt,
                existingToken
            );
        }
        bytes32 salt = deploymentSalt(creator, userSalt);
        bytes32 initCodeHash = tokenInitCodeHash(name_, symbol_, totalSupply_, recipient_);
        predicted = address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))
            )
        );
    }

        function deployToken(
        bytes32 userSalt,
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        address recipient_,
        uint256 maxDeploymentFee
    ) external payable nonReentrant returns (address token) {
        uint256 currentFee = deploymentFee;
        if (currentFee > maxDeploymentFee) {
            revert DeploymentFeeExceedsCallerLimit(currentFee, maxDeploymentFee);
        }
        if (msg.value != currentFee) {
            revert IncorrectNativeValue(currentFee, msg.value);
        }

        _validateTokenParameters(name_, symbol_, totalSupply_, recipient_);
        _validateFactoryRecipient(recipient_);
        address existingToken = tokenForSalt[msg.sender][userSalt];
        if (existingToken != address(0)) {
            revert CreatorSaltAlreadyUsed(
                msg.sender,
                userSalt,
                existingToken
            );
        }
        bytes32 salt = deploymentSalt(msg.sender, userSalt);
        address predicted = predictTokenAddress(
            msg.sender,
            userSalt,
            name_,
            symbol_,
            totalSupply_,
            recipient_
        );
        if (predicted.code.length != 0) revert TokenAlreadyDeployed(predicted);

        token = address(
            new KletiaFixedSupplyTokenV2{salt: salt}(
                name_,
                symbol_,
                totalSupply_,
                recipient_
            )
        );
        assert(token == predicted);
        tokenForSalt[msg.sender][userSalt] = token;

        if (currentFee != 0) {
            (bool sent, ) = treasury.call{value: currentFee}("");
            if (!sent) revert FeeTransferFailed(treasury, currentFee);
        }

        _emitTokenDeployment(
            token,
            recipient_,
            userSalt,
            salt,
            totalSupply_,
            currentFee
        );
        _emitTokenMetadata(token, name_, symbol_);
    }

    function setDeploymentFee(uint256 newFee) external onlyOwner {
        if (newFee > MAX_DEPLOYMENT_FEE) {
            revert DeploymentFeeAboveHardCap(newFee, MAX_DEPLOYMENT_FEE);
        }
        uint256 previousFee = deploymentFee;
        deploymentFee = newFee;
        emit DeploymentFeeUpdated(previousFee, newFee);
    }

    function proposeTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0) || newTreasury == address(this)) {
            revert InvalidAddress();
        }
        pendingTreasury = newTreasury;
        emit TreasuryProposed(treasury, newTreasury);
    }

    function acceptTreasury() external {
        address newTreasury = pendingTreasury;
        if (msg.sender != newTreasury) {
            revert UnauthorizedTreasuryAcceptance(
                msg.sender,
                newTreasury
            );
        }
        address previousTreasury = treasury;
        treasury = newTreasury;
        pendingTreasury = address(0);
        emit TreasuryUpdated(previousTreasury, newTreasury);
    }

    function renounceOwnership() public pure override {
        revert OwnershipRenunciationDisabled();
    }

    function _validateTokenParameters(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        address recipient_
    ) private pure {
        if (recipient_ == address(0)) revert InvalidAddress();
        if (totalSupply_ == 0 || totalSupply_ > MAX_TOKEN_SUPPLY) {
            revert InvalidSupply(totalSupply_);
        }
        if (!_isValidMetadata(bytes(name_), MAX_NAME_BYTES, true)) {
            revert InvalidName();
        }
        if (!_isValidMetadata(bytes(symbol_), MAX_SYMBOL_BYTES, false)) {
            revert InvalidSymbol();
        }
    }

    function _validateFactoryRecipient(
        address recipient_
    ) private view {
        if (recipient_ == address(this)) revert InvalidAddress();
    }

    function _emitTokenDeployment(
        address token,
        address recipient_,
        bytes32 userSalt,
        bytes32 salt,
        uint256 totalSupply_,
        uint256 currentFee
    ) private {
        emit TokenDeployed(
            token,
            msg.sender,
            recipient_,
            userSalt,
            salt,
            totalSupply_,
            currentFee
        );
    }

    function _emitTokenMetadata(
        address token,
        string calldata name_,
        string calldata symbol_
    ) private {
        emit TokenMetadataCommitted(token, name_, symbol_);
    }

        function _isValidMetadata(
        bytes memory value,
        uint256 maximumLength,
        bool allowInternalAsciiSpace
    ) private pure returns (bool) {
        uint256 length = value.length;
        if (length == 0 || length > maximumLength) return false;

        uint256 i;
        bool hasVisibleCodePoint;
        while (i < length) {
            uint8 first = uint8(value[i]);
            if (first <= 0x7f) {
                if (first < 0x20 || first == 0x7f) return false;
                if (first == 0x20) {
                    if (
                        !allowInternalAsciiSpace ||
                        i == 0 ||
                        i + 1 == length
                    ) return false;
                } else {
                    hasVisibleCodePoint = true;
                }
                unchecked {
                    ++i;
                }
                continue;
            }

            if (first >= 0xc2 && first <= 0xdf) {
                if (i + 1 >= length || !_isContinuation(value[i + 1])) return false;
                uint32 codePoint =
                    (uint32(first & 0x1f) << 6) |
                    uint32(uint8(value[i + 1]) & 0x3f);
                if (_isDisallowedMetadataCodePoint(codePoint)) return false;
                hasVisibleCodePoint = true;
                unchecked {
                    i += 2;
                }
                continue;
            }

            if (first >= 0xe0 && first <= 0xef) {
                if (
                    i + 2 >= length ||
                    !_isContinuation(value[i + 1]) ||
                    !_isContinuation(value[i + 2])
                ) return false;

                uint8 second = uint8(value[i + 1]);
                if ((first == 0xe0 && second < 0xa0) || (first == 0xed && second > 0x9f)) {
                    return false;
                }
                uint32 codePoint =
                    (uint32(first & 0x0f) << 12) |
                    (uint32(second & 0x3f) << 6) |
                    uint32(uint8(value[i + 2]) & 0x3f);
                if (_isDisallowedMetadataCodePoint(codePoint)) return false;
                hasVisibleCodePoint = true;
                unchecked {
                    i += 3;
                }
                continue;
            }

            if (first >= 0xf0 && first <= 0xf4) {
                if (
                    i + 3 >= length ||
                    !_isContinuation(value[i + 1]) ||
                    !_isContinuation(value[i + 2]) ||
                    !_isContinuation(value[i + 3])
                ) return false;

                uint8 second = uint8(value[i + 1]);
                if ((first == 0xf0 && second < 0x90) || (first == 0xf4 && second > 0x8f)) {
                    return false;
                }
                uint32 codePoint =
                    (uint32(first & 0x07) << 18) |
                    (uint32(second & 0x3f) << 12) |
                    (uint32(uint8(value[i + 2]) & 0x3f) << 6) |
                    uint32(uint8(value[i + 3]) & 0x3f);
                if (_isDisallowedMetadataCodePoint(codePoint)) return false;
                hasVisibleCodePoint = true;
                unchecked {
                    i += 4;
                }
                continue;
            }

            return false;
        }
        return hasVisibleCodePoint;
    }

    function _isContinuation(bytes1 character) private pure returns (bool) {
        uint8 value = uint8(character);
        return value >= 0x80 && value <= 0xbf;
    }

        function _isDisallowedMetadataCodePoint(
        uint32 codePoint
    ) private pure returns (bool) {
        return
            (codePoint >= 0x80 && codePoint <= 0x9f) ||
            codePoint == 0xa0 ||
            codePoint == 0xad ||
            codePoint == 0x34f ||
            codePoint == 0x61c ||
            (codePoint >= 0x115f && codePoint <= 0x1160) ||
            (codePoint >= 0x17b4 && codePoint <= 0x17b5) ||
            (codePoint >= 0x180b && codePoint <= 0x180f) ||
            codePoint == 0x1680 ||
            (codePoint >= 0x2000 && codePoint <= 0x200a) ||
            (codePoint >= 0x200b && codePoint <= 0x200f) ||
            (codePoint >= 0x2028 && codePoint <= 0x2029) ||
            (codePoint >= 0x202a && codePoint <= 0x202e) ||
            codePoint == 0x202f ||
            codePoint == 0x205f ||
            (codePoint >= 0x2060 && codePoint <= 0x206f) ||
            codePoint == 0x3000 ||
            codePoint == 0x3164 ||
            (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
            codePoint == 0xffa0 ||
            (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
            (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
            codePoint == 0xfeff ||
            (codePoint >= 0x1bca0 && codePoint <= 0x1bca3) ||
            (codePoint >= 0x1d173 && codePoint <= 0x1d17a) ||
            (codePoint >= 0xe0000 && codePoint <= 0xe0fff) ||
            (codePoint & 0xffff) >= 0xfffe;
    }
}
