
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

contract KletiaArcVault is ERC2771Context {

    address public owner;

    uint256 public apyBps;

    uint256 private constant BPS_DENOMINATOR = 10000;
    uint256 private constant SECONDS_PER_YEAR = 31536000;

    struct Deposit {
        uint256 principal;
        uint256 lastAccrualTimestamp;
        uint256 accruedInterest;
    }

    mapping(address => Deposit) public deposits;

    uint256 public totalDeposited;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    event Deposited(address indexed user, uint256 amount, uint256 totalPrincipal);
    event Withdrawn(address indexed user, uint256 principal, uint256 interest, uint256 totalPayout);
    event EmergencyWithdrawn(address indexed user, uint256 principal, uint256 forfeitedInterest);
    event APYUpdated(uint256 oldAPY, uint256 newAPY);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event VaultFunded(address indexed funder, uint256 amount);

    modifier onlyOwner() {
        require(_msgSender() == owner, "KletiaArcVault: caller is not the owner");
        _;
    }

    modifier nonReentrant() {
        require(_status != _ENTERED, "KletiaArcVault: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

        constructor(address trustedForwarder, uint256 _apyBps) ERC2771Context(trustedForwarder) {
        require(_apyBps <= 5000, "KletiaArcVault: APY too high"); 

        owner = _msgSender();
        apyBps = _apyBps;
        _status = _NOT_ENTERED;

        emit OwnershipTransferred(address(0), _msgSender());
        emit APYUpdated(0, _apyBps);
    }

    receive() external payable {
        emit VaultFunded(_msgSender(), msg.value);
    }

        function deposit() external payable nonReentrant {
        uint256 amount = msg.value;
        require(amount > 0, "KletiaArcVault: amount must be > 0");

        Deposit storage d = deposits[_msgSender()];

        if (d.principal > 0) {
            d.accruedInterest += _calculateInterest(d.principal, d.lastAccrualTimestamp);
        }

        d.principal += amount;
        d.lastAccrualTimestamp = block.timestamp;
        totalDeposited += amount;

        emit Deposited(_msgSender(), amount, d.principal);
    }

        function withdraw() external nonReentrant {
        Deposit storage d = deposits[_msgSender()];
        require(d.principal > 0, "KletiaArcVault: no active deposit");

        uint256 interest = d.accruedInterest + _calculateInterest(d.principal, d.lastAccrualTimestamp);
        uint256 principal = d.principal;
        uint256 totalPayout = principal + interest;

        if (address(this).balance < totalPayout) {
            uint256 availableInterest = address(this).balance > principal ? address(this).balance - principal : 0;
            totalPayout = principal + availableInterest;
            interest = availableInterest;
        }

        unchecked {
            totalDeposited -= principal;
        }
        d.principal = 0;
        d.accruedInterest = 0;
        d.lastAccrualTimestamp = 0;

        (bool success, ) = payable(_msgSender()).call{value: totalPayout}("");
        require(success, "KletiaArcVault: USDC native transfer failed");

        emit Withdrawn(_msgSender(), principal, interest, totalPayout);
    }

        function emergencyWithdraw() external nonReentrant {
        Deposit storage d = deposits[_msgSender()];
        require(d.principal > 0, "KletiaArcVault: no active deposit");

        uint256 principal = d.principal;
        uint256 forfeited = d.accruedInterest + _calculateInterest(principal, d.lastAccrualTimestamp);

        unchecked {
            totalDeposited -= principal;
        }
        d.principal = 0;
        d.accruedInterest = 0;
        d.lastAccrualTimestamp = 0;

        (bool success, ) = payable(_msgSender()).call{value: principal}("");
        require(success, "KletiaArcVault: USDC native transfer failed");

        emit EmergencyWithdrawn(_msgSender(), principal, forfeited);
    }

        function setAPY(uint256 newApyBps) external onlyOwner {
        require(newApyBps <= 5000, "KletiaArcVault: APY too high");
        uint256 oldApy = apyBps;
        apyBps = newApyBps;
        emit APYUpdated(oldApy, newApyBps);
    }

        function fundVault() external payable onlyOwner {
        require(msg.value > 0, "KletiaArcVault: amount must be > 0");
        emit VaultFunded(_msgSender(), msg.value);
    }

        function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "KletiaArcVault: invalid new owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

        function pendingInterest(address user) external view returns (uint256) {
        Deposit storage d = deposits[user];
        if (d.principal == 0) return 0;
        return d.accruedInterest + _calculateInterest(d.principal, d.lastAccrualTimestamp);
    }

        function claimableAmount(address user) external view returns (uint256) {
        Deposit storage d = deposits[user];
        if (d.principal == 0) return 0;
        return d.principal + d.accruedInterest + _calculateInterest(d.principal, d.lastAccrualTimestamp);
    }

        function vaultBalance() external view returns (uint256) {
        return address(this).balance;
    }

        function _calculateInterest(uint256 principal, uint256 since) internal view returns (uint256) {
        if (since == 0 || principal == 0) return 0;
        uint256 elapsed;
        unchecked {
            elapsed = block.timestamp - since;
        }
        return (principal * apyBps * elapsed) / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
    }
}
