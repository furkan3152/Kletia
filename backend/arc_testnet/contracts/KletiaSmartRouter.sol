// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title KletiaSmartRouter
 * @dev Kletia Omni-Engine için Güvenli Yönlendirici (Blockaid-Proof)
 * Bu kontrat, %0.1 protokol komisyonunu kestikten sonra kalan miktarı
 * güvenli bir şekilde (SafeERC20 kullanarak) hedef DEX/Protokol'e aktarır
 * ve arbitraj/swap işlemlerini yerine getirir.
 */
contract KletiaSmartRouter is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // Protokol Komisyon Oranı (Örn: 10 = %0.1, 100 = %1)
    // Payda (Denominator) = 10000
    uint256 public feeBasisPoints = 10; 
    address public feeTreasury;

    // --- GÜVENLİK YAMASI: Whitelist (Beyaz Liste) ---
    mapping(address => bool) public approvedTargets;

    event ExecutedERC20(address indexed tokenIn, uint256 grossAmount, uint256 feeAmount, address indexed targetProtocol);
    event ExecutedETH(uint256 grossAmount, uint256 feeAmount, address indexed targetProtocol);
    event FeeUpdated(uint256 newFeeBasisPoints);
    event TreasuryUpdated(address newTreasury);
    event TargetApproved(address indexed target, bool isApproved);

    modifier onlyApprovedTarget(address target) {
        require(approvedTargets[target], "Security: Target protocol is not whitelisted");
        _;
    }

    /**
     * @dev Constructor, varsayılan sahibi ve komisyon cüzdanını ayarlar.
     * @param _initialOwner Kontratın sahibi (Admin cüzdanı)
     * @param _feeTreasury Kesilen komisyonların gönderileceği cüzdan
     */
    constructor(address _initialOwner, address _feeTreasury) Ownable(_initialOwner) {
        require(_feeTreasury != address(0), "Treasury cannot be zero address");
        feeTreasury = _feeTreasury;
    }

    /**
     * @dev ETH İşlemleri için Yönlendirici
     * Komisyon anında kesilir ve treasury'ye yollanır, kalan miktar ile hedef protokol çağrılır.
     * @param targetProtocol İşlemin yapılacağı hedef protokol (Örn: Uniswap V2 Router)
     * @param targetCalldata Hedef protokole gönderilecek veri
     */
    function executeETH(address targetProtocol, bytes calldata targetCalldata) external payable nonReentrant whenNotPaused onlyApprovedTarget(targetProtocol) {
        require(msg.value > 0, "No ETH provided");
        require(targetProtocol != address(0), "Invalid target protocol");

        // Komisyon Hesabı
        uint256 feeAmount = (msg.value * feeBasisPoints) / 10000;
        uint256 netAmount = msg.value - feeAmount;

        // Komisyonu Treasury'e aktar
        if (feeAmount > 0) {
            (bool feeSuccess, ) = feeTreasury.call{value: feeAmount}("");
            require(feeSuccess, "Fee transfer failed");
        }

        // Ana işlemi hedef protokole yolla (Call - DelegateCall değil!)
        (bool success, bytes memory returnData) = targetProtocol.call{value: netAmount}(targetCalldata);
        
        if (!success) {
            // Revert sebebini kullanıcıya geri fırlat (Blockaid şeffaflığı)
            if (returnData.length > 0) {
                assembly {
                    let returnData_size := mload(returnData)
                    revert(add(32, returnData), returnData_size)
                }
            } else {
                revert("Target call failed");
            }
        }

        // Kalan (harcanmayan) ETH varsa kullanıcıya iade et
        uint256 remaining = address(this).balance;
        if (remaining > 0) {
            (bool refundSuccess, ) = msg.sender.call{value: remaining}("");
            require(refundSuccess, "Refund failed");
        }

        emit ExecutedETH(msg.value, feeAmount, targetProtocol);
    }

    /**
     * @dev ERC-20 İşlemleri için Yönlendirici
     * Kullanıcı bu kontrata "Approve" vermelidir.
     * @param tokenIn İşlem yapılacak giriş tokeni
     * @param totalAmount Toplam çekilecek miktar (Komisyon Dahil)
     * @param targetProtocol İşlemin yapılacağı hedef protokol (Örn: Uniswap V2 Router)
     * @param targetCalldata Hedef protokole gönderilecek veri
     */
    function executeERC20(
        address tokenIn,
        uint256 totalAmount,
        address targetProtocol,
        bytes calldata targetCalldata
    ) external nonReentrant whenNotPaused onlyApprovedTarget(targetProtocol) {
        require(totalAmount > 0, "Amount must be greater than zero");
        require(targetProtocol != address(0), "Invalid target protocol");
        require(tokenIn != address(0), "Invalid token address");

        IERC20 token = IERC20(tokenIn);

        // Kullanıcıdan tüm miktarı bu kontrata çek
        token.safeTransferFrom(msg.sender, address(this), totalAmount);

        // Komisyon Hesabı
        uint256 feeAmount = (totalAmount * feeBasisPoints) / 10000;
        uint256 netAmount = totalAmount - feeAmount;

        // Komisyonu Treasury'e gönder
        if (feeAmount > 0) {
            token.safeTransfer(feeTreasury, feeAmount);
        }

        // Kalan net miktarı hedef protokole onayla (Approve)
        token.forceApprove(targetProtocol, netAmount);

        // Hedef protokolü çağır (Kletia üzerinden)
        (bool success, bytes memory returnData) = targetProtocol.call(targetCalldata);
        
        if (!success) {
            // Revert sebebini kullanıcıya geri fırlat (Şeffaf hata tespiti)
            if (returnData.length > 0) {
                assembly {
                    let returnData_size := mload(returnData)
                    revert(add(32, returnData), returnData_size)
                }
            } else {
                revert("Target call failed");
            }
        }

        // İşlem bittikten sonra hedef protokoldeki allowance'ı sıfırla (Güvenlik standardı)
        token.forceApprove(targetProtocol, 0);

        // Kalan (harcanmayan) ERC20 tokeni varsa kullanıcıya iade et
        uint256 remaining = token.balanceOf(address(this));
        if (remaining > 0) {
            token.safeTransfer(msg.sender, remaining);
        }

        emit ExecutedERC20(tokenIn, totalAmount, feeAmount, targetProtocol);
    }

    // --- YÖNETİCİ (ADMIN) FONKSİYONLARI ---

    /**
     * @dev Güvenli hedef protokol ekleme / çıkarma (Sadece Owner)
     */
    function setApprovedTarget(address target, bool isApproved) external onlyOwner {
        require(target != address(0), "Invalid target address");
        approvedTargets[target] = isApproved;
        emit TargetApproved(target, isApproved);
    }

    function setFeeBasisPoints(uint256 _newFee) external onlyOwner {
        require(_newFee <= 500, "Fee cannot exceed 5% (500 bps)"); // Max %5
        feeBasisPoints = _newFee;
        emit FeeUpdated(_newFee);
    }

    function setFeeTreasury(address _newTreasury) external onlyOwner {
        require(_newTreasury != address(0), "Invalid treasury address");
        feeTreasury = _newTreasury;
        emit TreasuryUpdated(_newTreasury);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Kontrata sıkışan tokenları kurtarmak için (Güvenlik Önlemi)
     */
    function rescueTokens(address tokenAddress, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid destination");
        if (tokenAddress == address(0)) {
            (bool success, ) = to.call{value: amount}("");
            require(success, "ETH rescue failed");
        } else {
            IERC20(tokenAddress).safeTransfer(to, amount);
        }
    }

    // Kontratın ETH alabilmesi için
    receive() external payable {}
}
