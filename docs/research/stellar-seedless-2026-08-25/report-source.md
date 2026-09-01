# Kletia Stellar Seedless Account ve Ortak Arayüz Kararı

Tarih: 25 Ağustos 2026  
Durum: Resmî Smart Account Kit tabanlı, Testnet-only passkey hesap MVP'si runtime'a eklendi. EVM kimlik binding'i, ikinci signer/recovery ve mainnet açılımı henüz tamamlanmadı.

## Uygulama sonucu

Kletia'nın Stellar Dashboard'u artık uzantı veya seed phrase istemeden cihaz
passkey'iyle gerçek bir Stellar Testnet `C...` smart account oluşturabilir,
yeniden bağlayabilir, canlı XLM SAC bakiyesini okuyabilir, Testnet fonu alabilir
ve passkey onaylı XLM transferi gönderebilir. Browser trafiği Kletia'nın sınırlı
relay endpoint'inden resmî referans Testnet relayer'ına gider; backend açılışı
pinlenmiş account WASM, WebAuthn verifier, native XLM SAC ve relayer network
kimlikleri eşleşmezse kapanır.

25 Ağustos 2026 canlı tarayıcı yaşam döngüsü:

- Smart account: `CAIAS5WPAWKIDR27WS6WH6JMZFRAMFKNGU6JFK2EC3557YBXAILFDOSA`
- Deploy: `effbef2abdfe1a391efc1950be23061ff61b96b18cdd1bda648c471235dfc571`
- Testnet funding: `2c14dfbb6e61c05abcd766071d9c2f4086e073380f7654c832b6167661b183b5`
- Passkey ile 1 XLM transferi: `c9e4ebfa7c76cdb39e930f439a9429d5245aa2ebbb4d8bcfccf0af2ac29f890c`
- Stellar RPC sonucu: `SUCCESS`; smart-account bakiyesi `9995` XLM'den
  `9994` XLM'ye düştü.

Bu kanıt yalnız Testnet MVP yaşam döngüsüdür. Smart Account Kit entegrasyonu
unaudited durumdadır; EVM cüzdanı bugün arayüzde oturum bağlamıdır ve Stellar
fonlarını harcayamaz. Classic SDEX, trustline ve memo işlemleri Freighter
uyumluluk hesabında kalır.

## Kısa karar

Kletia'nın Stellar ekranı Base, Arc ve Arbitrum ile aynı ortak niyet kabuğunu
kullanmalıdır. Stellar'a özgü manuel araçlar, Arc Dashboard gibi ayrı bir
dashboard sekmesinde bulunmalıdır.

Seedless Stellar deneyimi için önerilen hesap bir passkey tarafından yönetilen
Stellar smart account'tur (`C...`). Bağlı EVM cüzdanı (`0x...`) bu hesabın Kletia
içindeki kimlik eşini seçer; Stellar fonlarını tek başına harcama yetkisi vermez.
EVM imzasından Stellar private key veya passkey üretilmez.

Mevcut Classic Stellar işlemleri nedeniyle ilk sürüm hibrit olmalıdır:

- Soroban ve Stellar Asset Contract işlemleri: passkey smart account (`C...`).
- Classic payment, trustline, memo ve SDEX path payment: Freighter ile Classic
  Stellar account (`G...`).
- Arayüz bu iki hesabı tek kullanıcı profili altında gösterir, fakat imza ve
  işlem sınırlarını saklamaz.

## Resmî kaynakların doğruladığı gerçekler

1. Stellar smart wallet, `__check_auth` kullanan bir contract account'tur.
   Passkey/WebAuthn ve harcama limiti gibi özel kurallar desteklenir.
2. Protocol 21, secp256r1 doğrulamasını Soroban host'a eklemiştir. WebAuthn
   passkey'leri bu eğriyi kullanır.
3. Passkey masaüstünde çalışır. Platform authenticator, cihaz PIN'i/biometriği,
   senkronize passkey, telefon veya harici güvenlik anahtarı kullanılabilir.
4. WebAuthn origin ve RP ID'ye bağlıdır. Production alan adı ve HTTPS kalıcı
   tasarım girdileridir; domain değişimi recovery planı olmadan yapılamaz.
5. Contract account XLM ve Stellar varlıklarını SAC üzerinden tutabilir ve G
   hesaplara transfer edebilir.
6. Classic payment operasyonları contract address'i kaynak veya hedef yapamaz.
   Stellar order book işlevi de SAC içinde sunulmaz. Bu nedenle mevcut SDEX ve
   Classic ödeme yolları passkey `C...` hesabına mekanik olarak taşınamaz.
7. Güncel Stellar Smart Account Kit; passkey, çoklu signer, policy ve fee
   sponsorship yüzeyleri sunar. Entegrasyon SDK/demo/relayer kodu unaudited
   olarak işaretlenmiştir. Testnet deployment kimlikleri ve WASM hash'leri
   ayrıca pinlenmelidir.

## Neden EVM cüzdanından Stellar anahtarı türetmiyoruz?

Bir wallet imzasını entropy veya seed gibi kullanmak güvenli bir standart
değildir. Aynı mesajın tekrar imzalanabilirliği, wallet implementasyonu,
domain ayrımı ve recovery davranışı kullanıcı fonlarının anahtarına dönüşmemeli.
Ayrıca EVM adresi secp256k1, Stellar Classic hesap Ed25519 ve WebAuthn passkey
secp256r1 kullanır. Bunlar aynı adres veya aynı signer değildir.

EVM cüzdanının doğru rolü kimlik eşlemesidir:

1. Kullanıcı mevcut EVM cüzdanını bağlar.
2. Kletia browser'da bir passkey oluşturur veya mevcut passkey'i bulur.
3. Smart Account Kit deterministik `C...` adresini üretir ve Testnet'te deploy
   eder; fee ayrı ve sınırlı bir relayer tarafından sponsorlanabilir.
4. Kullanıcı bir defalık, süreli ve nonce'lu EIP-712 binding mesajını EVM
   cüzdanıyla imzalar.
5. Kletia şu eşlemeyi tutar: environment + EVM address + Stellar smart account
   + passkey credential public identifier hash.
6. Stellar para hareketi her zaman passkey veya açıkça seçilmiş Stellar signer
   tarafından yetkilendirilir. Binding imzası transfer yetkisi değildir.
7. EVM hesabı değişirse Kletia farklı Stellar profilini açar; eski hesabı
   otomatik olarak devralmaz.

## Önerilen kullanıcı deneyimi

### Varsayılan ekran

- Diğer ağlarla aynı navbar, sidebar, intent starter ve alt composer.
- Kullanıcı “5 XLM'i USDC'ye çevir” yazar.
- Kletia bunu ilgili Stellar aracına yönlendirir.
- Manual ekran yalnız gerekli alanları ve gerçek readiness durumunu gösterir.

### Hesap kartı

- `Kletia Smart Account`: passkey ile seedless `C...` hesap; Soroban/SAC için.
- `Classic Stellar`: Freighter `G...` hesap; SDEX, trustline ve Classic ödeme
  uyumluluğu için.
- Kullanıcı teknik adresleri genişletebilir, fakat ana görünümde “Smart account”
  ve “Classic uyumluluk hesabı” isimlerini görür.

### Recovery

- İlk fonlamadan önce ikinci passkey veya açık recovery signer ekleme önerilir.
- Senkronize passkey bulunamazsa EVM imzası tek başına fon kurtaramaz.
- RP ID/domain migration planı, hesap deployment'ından önce sabitlenir.
- Recovery ve signer değişiklikleri ayrı, kullanıcı tarafından açıkça onaylanan
  Stellar işlemleridir.

## MVP uygulama sırası

1. Smart Account Kit sürümünü, Protocol 27 WASM hash'lerini ve verifier contract
   ID'lerini manifestte pinle; runtime code identity kontrolü ekle.
2. Testnet-only capability flag ekle. Eksik relayer, HTTPS/RP ID veya pin varsa
   özellik `unavailable` olsun.
3. Browser'da create/connect passkey akışını ekle; private credential materyali
   API'ye veya loglara gitmesin.
4. Server-side fee sponsor/relayer endpoint'ini method, network, contract,
   kullanıcı ve günlük bütçe allowlist'leriyle sınırla. Secret browser'a gitmesin.
5. EIP-712 `KletiaStellarBindingV1` mesajını nonce, expiry, environment,
   network passphrase hash, EVM address, `C...` address ve RP ID ile bağla.
6. Önce yalnız SAC XLM transferi ve read-only balance ile canlı Testnet
   lifecycle kanıtı üret.
7. Freighter Classic akışlarını koru; SDEX/trustline/payment işlemlerini smart
   account üzerinden çalışıyor gibi göstermeyi reddet.
8. İkinci passkey/recovery signer, domain migration ve sponsor suistimali için
   adversarial testleri geçmeden mainnet capability açma.

## Release kapıları

- Fresh desktop passkey create -> deploy -> fund -> signed SAC transfer kanıtı.
- Reload ve passkey reconnect kanıtı.
- EVM account switch ile yanlış `C...` hesabın açılamadığını gösteren test.
- Binding replay, expired nonce, farklı origin/RP ID ve farklı Stellar network
  denemelerinin reddedilmesi.
- Relayer cap/allowlist, idempotency ve indeterminate recovery testleri.
- Freighter Classic/SDEX regresyon testleri.
- Kullanıcının hem `C...` hem `G...` bakiyesini yanlış biçimde tek bakiye gibi
  görmediği UI testi.
- Smart Account Kit'in unaudited entegrasyon durumu kullanıcıya ve release
  manifestine açıkça yazılmalı.

## Kaynaklar

- Stellar Docs — Contract Accounts:
  https://developers.stellar.org/docs/build/guides/contract-accounts
- Stellar Docs — Smart Wallets:
  https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets
- Stellar Docs — Authorization:
  https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization
- Stellar Docs — Send to and receive payments from Contract Accounts:
  https://developers.stellar.org/docs/build/guides/transactions/send-and-receive-c-accounts
- Stellar Docs — Send and receive payments:
  https://developers.stellar.org/docs/build/guides/transactions/send-and-receive-payments
- Stellar Docs — Stellar Asset Contract:
  https://developers.stellar.org/docs/tokens/stellar-asset-contract
- Stellar Protocol CAP-0051 — secp256r1 verification:
  https://github.com/stellar/stellar-protocol/blob/master/core/cap-0051.md
- Stellar Smart Account Kit:
  https://github.com/stellar/smart-account-kit
- Smart Account Kit Protocol 27 deployment manifest:
  https://github.com/stellar/smart-account-kit/blob/main/docs/deployments-protocol-27-2026-07-09.md
- W3C WebAuthn Level 3:
  https://www.w3.org/TR/webauthn-3/
