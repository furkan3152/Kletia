const fs = require('fs');
const path = require('path');

const dir = './src';

const replacements = {
  "Para yükleme servisine şu an erişilemiyor. Lütfen daha sonra tekrar deneyin.": "The funding service is currently unavailable. Please try again later.",
  "Ağ bağlantısı sağlanamadı.": "Network connection failed.",
  "İşlem iptal edildi.": "Transaction cancelled.",
  "Bilinmeyen bir hata oluştu.": "An unknown error occurred.",
  "İşlem Başarısız": "Transaction Failed",
  "MetaMask İmza İstendi": "MetaMask Signature Requested",
  "MetaMask'tan onay bekleniyor...": "Waiting for MetaMask confirmation...",
  "İmza Başarılı!": "Signature Successful!",
  "İptal / Hata": "Cancelled / Error",
  "SİMÜLASYON BAŞARISIZ": "SIMULATION FAILED",
  "Simülasyon Başarılı": "Simulation Successful",
  "Varsayılan Gaz Limiti ile Devam Ediliyor": "Continuing with Default Gas Limit",
  "Lütfen asıl işlemi MetaMask'tan onaylayın.": "Please confirm the main transaction in MetaMask.",
  "MetaTx Başarısız": "MetaTx Failed",
  "Kletia Relayer ağına iletiliyor": "Forwarding to Kletia Relayer network",
  "Gasless İmza Talebi Oluşturuluyor": "Creating Gasless Signature Request",
  "Kullanıcı Onayı Bekleniyor": "Waiting for User Approval",
  "İşlem Başarılı": "Transaction Successful",
  "Bir hata oluştu": "An error occurred",
  "Uyarı": "Warning",
  "Hesap": "Account",
  "Bağlan": "Connect",
  "Cüzdan": "Wallet",
  "Ağ": "Network",
  "Gönder": "Send",
  "Onayla": "Confirm",
  "Bekleniyor": "Pending",
  "Tamamlandı": "Completed",
  "Başarılı": "Success",
  "Hata": "Error",
  "İptal": "Cancel",
  "Geri": "Back",
  "İleri": "Next",
  "Kapat": "Close",
  "Açık": "Open",
  "Kapalı": "Closed",
  "Yeni": "New",
  "Eski": "Old",
  "Güncelle": "Update",
  "Sil": "Delete",
  "Ekle": "Add",
  "Çıkar": "Remove",
  "Bağlantı Kes": "Disconnect",
  "Ağı Değiştir": "Switch Network",
  "Ağ Değiştirildi": "Network Switched",
  "Lütfen bekleyin...": "Please wait...",
  "Yükleniyor...": "Loading...",
  "Yükleniyor": "Loading",
  "Arama...": "Search...",
  "Bulunamadı": "Not Found",
  "Sonuç Yok": "No Results",
  "Evet": "Yes",
  "Hayır": "No",
  "Kabul Et": "Accept",
  "Reddet": "Reject",
  "Devam Et": "Continue"
};

function processDirectory(directory) {
  const files = fs.readdirSync(directory);
  for (const file of files) {
    const fullPath = path.join(directory, file);
    if (fs.statSync(fullPath).isDirectory()) {
      processDirectory(fullPath);
    } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      let changed = false;
      for (const [tr, en] of Object.entries(replacements)) {
        if (content.includes(tr)) {
          content = content.split(tr).join(en);
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(fullPath, content, 'utf8');
        console.log('Translated:', fullPath);
      }
    }
  }
}

processDirectory(dir);
