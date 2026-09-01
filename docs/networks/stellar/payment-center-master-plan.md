# Kletia Stellar Payment Center — Ana Faaliyet ve Dönüşüm Planı

Tarih: 28 Ağustos 2026  
Durum: Uygulama öncesi mimari karar belgesi  
Kapsam: Stellar'ın Kletia içindeki ana rolü, passkey hesapları, anchor
entegrasyonları, multichain fonlama, eski araştırma yüzeylerinin ayrıştırılması,
test ve release kanıtları

## 1. Yönetici kararı

Kletia'nın Stellar ürünü **Stellar Payment Passport + Payment Center** olarak
konumlandırılacaktır.

Tek cümlelik ürün tanımı:

> Kletia, kullanıcının doğal dildeki gerçek ödeme hedefini; herhangi bir
> desteklenen ağdaki USDC'den, Stellar üzerinde passkey ile sahip olunan ödeme
> kimliğine ve oradan doğrulanmış bir yerel ödeme rayına dönüştürür.

Bu karar şu üç yanlış konumlandırmayı reddeder:

1. Stellar bütün EVM hesaplarını yöneten evrensel ana cüzdan değildir.
2. Stellar, ilgisiz Base/Arc/Arbitrum DeFi işlemlerine zorla eklenen bir hop
   değildir.
3. Bond, auction, policy root veya ZK proof tek başına yabancı zincirdeki
   işlemi çözen bir settlement sistemi değildir.

Stellar'ın gerekli olduğu alan şudur:

- Kullanıcıya seed phrase göstermeyen, WebAuthn `secp256r1` ile kontrol edilen
  bir Stellar C-account ödeme kimliği verir.
- Aynı kimliği standart anchor oturumuna bağlayabilir.
- Circle USDC'yi Stellar'da ortak ödeme varlığı olarak tutar.
- SEP-1, SEP-24/6, SEP-38 ve SEP-45 ile birden çok sağlayıcıyı aynı istemci
  modelinde keşfetme, doğrulama, fiyatlama ve takip etme imkânı verir.
- Yerel banka/cash/mobile-money rayının `completed`, `pending_external`,
  `refunded`, `expired` veya `error` sonucunu zincir transferinden ayrı izler.

Bu birleşik yapı Kletia'ya yalnız bir passkey veya yalnız bir off-ramp
eklemekten daha fazlasını kazandırır: Kletia'nın AI intent motoru ilk kez
"token taşı" yerine "kişiye yerel para ulaştır" sonucunu standart, sağlayıcıdan
bağımsız ve recovery-aware biçimde derleyebilir.

## 2. Araştırmayla kesinleşen protokol sınırları

### 2.1 Passkey ve C-account

Stellar smart wallet'ları `__check_auth` ile programlanabilir yetkilendirme
uygular. Protocol 21, WebAuthn'ın yaygın eğrisi olan `secp256r1` imzalarını
native doğrular. Bu; passkey, birden çok signer, limit, allowlist ve zaman
kuralını onchain hesap yetkisine taşıyabilir.

Kaynak:
[Stellar Smart Wallets](https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets)

Mevcut Kletia entegrasyonu `smart-account-kit` 0.6.2 kullanır. Ancak SDK, demo,
relayer proxy ve entegrasyon kodu bağımsız audit geçmemiştir; OpenZeppelin
kontrat audit'i ayrı kapsam ve daha eski source revision içindir. Bu nedenle
mevcut yüzey Testnet ürün kanıtıdır, production custody güvencesi değildir.

Kaynak:
[Stellar Smart Account Kit](https://github.com/stellar/smart-account-kit)

### 2.2 SEP-45

SEP-45, C-account'un bir anchor/web servisine sahipliğini kanıtlayıp JWT oturumu
almasını sağlar. Onchain SAC transferinin kendisi SEP-45 değildir; transferi
smart wallet `__check_auth` ile yetkilendirir. SEP-45 yalnız servis oturumudur.

Anchor Platform Ağustos 2026 itibarıyla SEP-45 challenge/response, Soroban
simulation ve C-account oturumunu destekler. Fakat SEP-45 hâlâ Draft
statüsündedir; kullanılan versiyon manifestte pinlenmeli ve davranış değişikliği
release gate'i kapatmalıdır.

Kaynak:
[Anchor Platform SEP-45](https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep45)

### 2.3 SEP-24/6 ile SEP-31 aynı ürün değildir

- **SEP-24** cüzdan ile anchor arasında hosted deposit/withdraw akışıdır.
  SEP-45 ile C-account destekler ve doğrudan kullanıcı off-ramp MVP'sinin doğru
  protokolüdür.
- **SEP-6** aynı sınıfın programmatic varyantıdır. Daha fazla alanı Kletia'nın
  işlemesini gerektirir; hosted flow yeterli olmadığı zaman ikinci adaptördür.
- **SEP-31** iki anchor/finansal kuruluş arasında cross-border payment
  protokolüdür. Receiving anchor, yalnız ikili anlaşması bulunan sending
  anchor'ın SEP-10 kimliğini kabul eder. Kullanıcı C-account'un SEP-45 JWT'si
  SEP-31 sending-anchor kimliğinin yerine geçmez.

Kaynaklar:
[SEP-24](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md),
[SEP-6](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0006.md),
[SEP-31](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0031.md)

Sonuç:

- MVP doğrudan off-ramp: SEP-24 + SEP-45 + SEP-38.
- İleri seviye programmatic off-ramp: SEP-6 + SEP-45 + SEP-12 + SEP-38.
- Başka bir kişiye kurumsal cross-border payout: yalnız gerçek sending-anchor
  partneriyle SEP-31.
- Kletia sending anchor olmadığı sürece "SEP-31 ile kullanıcı doğrudan ödeme
  gönderir" iddiası yapılmayacaktır.

### 2.4 C-account'tan anchor'a ödeme

C-account USDC transferi Classic `payment` operation değil, USDC SAC
`transfer` invocation'ıdır. Contract invocation memo taşıyamadığı için anchor
`id` memo verirse bu değer alıcının G-address'iyle M-address'e çevrilmelidir.
`text` veya `hash` memo isteyen sağlayıcı, C-account execution için uygun
sayılmayacaktır.

Protocol 23/CAP-67 sonrası Horizon ve RPC, Classic payment ile SAC transferini
standardize edilmiş asset events olarak gözleyebilir. Buna rağmen her anchor'ın
bu gözlem yolunu gerçekten kullandığı canlı olarak test edilmelidir.

Kaynak:
[Send to and receive payments from Contract Accounts](https://developers.stellar.org/docs/build/guides/transactions/send-and-receive-c-accounts)

### 2.5 SEP-38

Indicative `/price` yalnız karşılaştırma içindir. Gerçek execution öncesinde
SEP-45/10 authenticated `POST /quote` ile firm quote alınır; ID, exact asset,
amount, delivery method, country ve expiry ödeme planına bağlanır. SEP-38 Draft
olduğu için adapter versiyonu ve response şeması pinlenir.

Kaynak:
[SEP-38 Anchor RFQ API](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0038.md)

### 2.6 SEP-59

SEP-59, aynı C-account'a bağlı reusable virtual bank account, bank credential
ve crypto deposit address sağlamayı hedefleyen güçlü bir "Payment Passport
Ingress" adayıdır. Ancak Ağustos 2026'da Draft 0.4.0'dır ve SEP-45 C-account
yolu çalışan bir implementasyona karşı henüz doğrulanmamıştır.

Bu nedenle:

- MVP kritik yolunda değildir.
- Ayrı experimental capability olarak araştırılır.
- Canlı provider ve C-account evidence olmadan UI'ya girmez.

Kaynak:
[SEP-59 External Account API](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0059.md)

### 2.7 Circle CCTP

Circle'ın güncel domain tablosu Arc Testnet 26, Stellar 27, Arbitrum 3 ve Base
6 domainlerini destekler. Stellar inbound transferinde address encoding ve
7-decimal farkı vardır; `CctpForwarder` kullanılır. `mint_and_forward`, Stellar
içindeki mint + recipient transferini tek Soroban invocation'ında atomik yapar;
CCTP'nin bütünü global atomik değildir.

Kaynaklar:
[CCTP supported domains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains),
[CCTP Stellar contracts](https://developers.circle.com/cctp/references/stellar-contracts)

## 3. Ürün kapsamı

### 3.1 Varsayılan ürün

Varsayılan Stellar workspace yalnız şu dört işi yapar:

1. Passkey Payment Passport oluşturma, bağlama ve recovery.
2. XLM/USDC bakiye ve native Stellar ödeme araçları.
3. Gerçek anchor üzerinden fiat giriş/çıkış ve status/recovery.
4. Desteklenen EVM/Arc USDC'yi kullanıcının Stellar C-account'una CCTP ile
   getirip ödeme için hazırlama.

### 3.2 Kaynak ağın sahip olduğu işler

- Base swap/lending/x402/token launch: Base workspace.
- Arc swap/lending/staking/vault: Arc workspace.
- Arbitrum swap/lending: Arbitrum workspace.
- Arc -> Arbitrum -> Aave: existing reviewed cross-chain executor.
- Arc/Base USDC -> yerel banka hesabı: source workspace fonlama adımını açar,
  Payment Center sonucu devralır.

### 3.3 Varsayılan üründe olmayacaklar

- Solver auction ve bonded bid UX'i.
- Stellar control-plane root'unu her multichain intent'e eklemek.
- ZK policy'yi public EVM transferinin privacy kanıtı gibi sunmak.
- MPP veya private payments'ı ödeme merkezinin zorunlu parçası yapmak.
- SEP-31'i partner olmadan executable göstermek.
- SEP-59'u çalışıyor gibi sunmak.
- AI'a bank account, KYC belgesi, exact private amount veya credential göndermek.

## 4. Hedef mimari

```text
User intent
   |
   v
Deterministic Payment Intent Compiler
   |-- outcome: own off-ramp ----------> SEP-24 adapter
   |-- outcome: programmatic off-ramp --> SEP-6 adapter
   |-- outcome: recipient payout -------> SEP-31 partner adapter (gated)
   |-- outcome: pure DeFi --------------> source network workspace
   |
   v
Stellar Payment Passport (C-account)
   |-- passkey signer
   |-- backup/recovery signer
   |-- Stellar USDC balance
   |-- optional scoped payment policy later
   |
   +<-- source is EVM/Arc: CCTP -> Stellar C-account
   |
   v
Reviewed provider registry
SEP-1 identity -> SEP-45 session -> SEP-38 quote -> SEP-24/6/31 lifecycle
   |
   v
Anchor / local payment rail
completed | pending_external | needs_action | refunded | expired | error
```

### 4.1 Aktörler

| Aktör | Sahip olduğu yetki | Sahip olmadığı yetki |
| --- | --- | --- |
| Kullanıcı | Passkey, EVM wallet, source approval, Stellar payment approval | Provider/anchor işletme yetkisi |
| Kletia browser | Intent alanları, passkey assertion, review UX | Secret key, sınırsız session signer |
| Kletia API | Provider allowlist, schema validation, route ranking, durable state/evidence | Kullanıcı fonu, KYC belgesi, bank credential |
| Passkey relayer | Fee/sequence sağlayıp imzalı auth'ı submit etmek | C-account adına yeni intent üretmek |
| Anchor | KYC, firm quote, bank/cash raili, payout/refund | EVM wallet yetkisi |
| Circle/Iris | CCTP message ve attestation | Yerel ödeme sonucu |
| Stellar | C-account auth, USDC balance/transfer ve asset event | Banka transferinin finality'si |

### 4.2 Trust boundary kararı

- Kletia non-custodial kalır; fakat anchor/off-ramp rayı kendi şartlarına göre
  geçici custody ve compliance uygulayabilir. UI bunu gizlemez.
- Provider JWT, para harcama anahtarı değildir; yine de kullanıcı verisine ve
  provider işlemlerine erişim verdiği için kısa ömürlü ve şifreli tutulur.
- Anchor `completed` durumu provider kanıtıdır; bankanın bağımsız kriptografik
  finality proof'u değildir.
- CCTP mint kanıtı payout completion kanıtı değildir.

## 5. Canonical state machine

### 5.1 Üst seviye ödeme durumu

```text
draft
 -> provider_discovered
 -> indicative_quote_ready
 -> passport_required | passport_ready
 -> source_funding_not_needed | source_funding_required
 -> source_authorization_required
 -> source_submitted
 -> source_confirmed
 -> cctp_attestation_pending
 -> stellar_funded
 -> anchor_auth_required
 -> anchor_authenticated
 -> kyc_required | kyc_in_progress | kyc_ready
 -> firm_quote_ready
 -> withdrawal_incomplete
 -> withdrawal_ready_to_fund
 -> stellar_payment_authorization_required
 -> stellar_payment_submitted
 -> anchor_payment_observed
 -> pending_external
 -> completed
```

Terminal/recovery dalları:

```text
cancelled_before_funding
quote_expired
funding_indeterminate
authentication_expired
user_action_required
on_hold
refunded
expired
error
recovery_required
```

Kurallar:

1. `submitted` bir adım otomatik yeniden gönderilmez.
2. Aynı source hash / CCTP nonce / Stellar tx / anchor transaction ID üzerinden
   recovery yapılır.
3. Bir provider status'u bilinmiyorsa success'e map edilmez; adapter
   quarantine olur.
4. Firm quote süresi dolmuşsa ödeme hazırlanmaz.
5. C-account transferi yalnız anchor status'u `pending_user_transfer_start`
   olduğunda hazırlanır.
6. `completed` yalnız anchor transaction status'u ve gerekli external ID/status
   alanları doğrulandıktan sonra gösterilir.

### 5.2 Multichain fonlama sırası

Güvenli varsayılan iki aşamalıdır:

1. USDC, kullanıcının EVM/Arc wallet'ından kullanıcının Stellar C-account'una
   gelir.
2. Kullanıcı firm quote'u gördükten sonra C-account'tan anchor'a ayrı passkey
   onayı verir.

Bu sıra bridge süresi yüzünden firm quote'un boşa düşmesini önler. Kullanıcı
ödemeden vazgeçerse USDC hâlâ kendi C-account'undadır.

Just-in-time bridge yalnız şu koşulların tamamında açılır:

- Quote TTL, ölçülmüş CCTP p95 süre + güvenlik marjından uzundur.
- Circle route ve fee canlıdır.
- Destination C-account binding exact'tir.
- Quote expiry öncesi mint ve anchor receipt için yeterli süre vardır.
- Timeout halinde yeni burn yapılmaz.

## 6. Passkey hesap faaliyetleri

### 6.1 Mevcut yapının korunacak kısmı

- Pinned Testnet account WASM hash.
- Pinned WebAuthn verifier ve native SAC identity.
- Secure-context ve WebAuthn browser gate'leri.
- IndexedDB credential metadata.
- C-account live bytecode/readiness doğrulaması.

### 6.2 Düzeltilmesi gerekenler

1. `smart-account-kit` bağımlılığı `^0.6.2` yerine exact `0.6.2` pinlenir.
2. Reference relayer production dependency olmaktan çıkarılır.
3. Relayer XDR/auth entry decode eder; network, target, function, amount,
   account, fee cap ve replay key allowlist'i uygular.
4. USDC SAC bakiye ve transfer desteği eklenir.
5. G/C yanında M-address recipient desteği eklenir.
6. Anchor `id` memo, reviewed G-address + u64 memo'dan exact M-address'e
   çevrilir.
7. Backup passkey/hardware key ekleme, signer listeleme, signer removal ve
   recovery UX'i eklenir.
8. Belirlenen para eşiğinin üstünde ikinci signer yoksa funding engellenir.
9. Credential kaybı, browser reset, passkey sync ve ikinci cihaz recovery
   senaryoları ayrı test edilir.

### 6.3 İlk MVP'de yapılmayacak agent delegation

Backend AI signer eklenmeyecektir. İlk sürümde her anchor payment kullanıcı
passkey'i ister. Context rule/spending-limit ancak funded MVP sonrasında,
yalnız exact USDC SAC `transfer`, provider allowlist, günlük cap ve expiry ile
ayrı güvenlik incelemesinden sonra açılır.

## 7. Anchor/provider katmanı

### 7.1 Provider manifest

Her provider için review edilmiş manifest tutulur:

- domain ve organization identity,
- Stellar network/passphrase,
- `stellar.toml` snapshot hash,
- SEP-24/6/31/38/45 endpointleri,
- endpoint host allowlist,
- exact USDC issuer/SAC,
- country/currency/delivery-method tuple'ları,
- supported memo türleri,
- C-account SAC transfer observation kanıtı,
- KYC mode: hosted/direct,
- test/sandbox/production sınıfı,
- terms/privacy/support URL'leri,
- son review zamanı ve expiry,
- partner agreement gerektiren capability'ler.

TOML değişince otomatik trust update yapılmaz. Provider quarantine olur ve
manuel review ister.

### 7.2 Capability sınıfları

```text
discovered
indicative_quote_ready
sep45_ready
firm_quote_ready
sep24_contract_withdraw_ready
sep6_contract_withdraw_ready
sep31_partner_ready
sep59_experimental
quarantined
unavailable
```

Tek bir `ready` boolean kullanılmaz.

### 7.3 Testanchor'ın doğru kullanımı

`testanchor.stellar.org` şu an SEP-24, SEP-38, SEP-45 ve Circle Testnet USDC'yi
advertise eder; USDC deposit/withdraw aralığı 1–10'dur. Bu, protokol ve C-account
interoperability Testnet testi için uygundur.

28 Ağustos 2026 canlı kontrolünde Testanchor'ın SEP-38 implementasyonu standartta
tanımlı `context=sep24` değerini reddedip yalnız `sep6` ve `sep31` kabul etmiştir.
Bu nedenle Kletia onu SEP-24 yürütmesine bağlı canlı quote adayı olarak
göstermemeli; SEP-6 fiyatını sessizce SEP-24 quote'u gibi kullanmamalıdır. Bu
uyumsuzluk sağlayıcı manifestinde ve release evidence'da açıkça kalır.

Ancak testanchor'ın offchain transferi gerçek banka teslimatı değildir.
Kanıt etiketi `reference_anchor_testnet` olur; real-world payout iddiası için
ayrı regulated partner evidence gerekir.

## 8. Privacy ve veri sahipliği

### 8.1 Kletia API'ye girebilecek alanlar

- source network,
- amount veya private amount reference,
- country/currency/rail,
- provider ID,
- C-account public address,
- quote/transaction/evidence IDs,
- redacted destination label,
- state ve timestamps.

### 8.2 Kletia chat/model/log'a girmeyecek alanlar

- IBAN/bank account number,
- identity document,
- full legal name/address/date of birth,
- KYC images,
- provider JWT,
- passkey credential private material,
- unredacted beneficiary payload.

### 8.3 Hosted KYC kararı

MVP'de SEP-24 hosted interactive flow tercih edilir. KYC ve bank bilgisi
anchor-owned HTTPS penceresinde girilir. Kletia yalnız transaction ID, redacted
destination ve status görür.

Programmatic SEP-12 ancak şu koşullarda eklenir:

- provider gerçekten gerektiriyorsa,
- browser -> provider direct upload veya audited zero-retention proxy varsa,
- DPA, consent, deletion ve data-retention politikası hazırlanmışsa,
- error/telemetry/backup sistemlerinde PII sızıntısı test edilmişse.

## 9. API ve dosya mimarisi

### 9.1 Yeni backend modülleri

```text
apps/api/src/networks/stellar/payment-center/
  types.ts
  providerManifest.ts
  discovery.ts
  sep45Client.ts
  sep38Client.ts
  sep24Client.ts
  sep6Client.ts
  sep31PartnerClient.ts
  sep59ExperimentalClient.ts
  cAccountPayment.ts
  stateMachine.ts
  store.ts
  evidence.ts
  routes.ts
```

Mevcut `lastMile.ts`, yeni modüllere bölündükten sonra compatibility facade
olarak bir release tutulur; sonra kaldırılır.

### 9.2 Canonical API

```text
GET  /api/stellar/payment-center/readiness
GET  /api/stellar/payment-center/providers
POST /api/stellar/payment-center/quotes/indicative
POST /api/stellar/payment-center/sessions
GET  /api/stellar/payment-center/sessions/:id
POST /api/stellar/payment-center/sessions/:id/sep45/challenge
POST /api/stellar/payment-center/sessions/:id/sep45/complete
POST /api/stellar/payment-center/sessions/:id/funding/compile
POST /api/stellar/payment-center/sessions/:id/funding/evidence
POST /api/stellar/payment-center/sessions/:id/quotes/firm
POST /api/stellar/payment-center/sessions/:id/withdrawals/sep24
GET  /api/stellar/payment-center/sessions/:id/withdrawals/:txId
POST /api/stellar/payment-center/sessions/:id/stellar-payment/compile
POST /api/stellar/payment-center/sessions/:id/stellar-payment/evidence
POST /api/stellar/payment-center/sessions/:id/recover
GET  /api/stellar/payment-center/sessions/:id/receipt
```

Kurallar:

- Her mutation `Idempotency-Key` ister.
- Session ID tek başına yetki değildir; browser account binding ve kısa ömürlü
  session proof gerekir.
- API para gönderen signed XDR üretmez; exact invocation hazırlar, browser
  passkey ile auth entry imzalar.
- Response'lar provider/network/account/request identity taşır.
- Eski `/api/stellar/last-mile/*` endpointleri deprecation header ile yeni
  quote facade'ına yönlenir; execution eklenmez.

### 9.3 Frontend modülleri

```text
apps/web/src/networks/stellar/payment-center/
  PaymentIntentCard.tsx
  PaymentPassportCard.tsx
  ProviderQuoteCard.tsx
  HostedKycStep.tsx
  FundingTimeline.tsx
  WithdrawalTimeline.tsx
  RecoveryCard.tsx
  runtime/
    session.ts
    sep45.ts
    passkeyPayment.ts
    status.ts
```

Stellar ekranı Base/Arc tasarım sistemiyle aynı chat card ve staged execution
bileşenlerini kullanır. Teknik SEP isimleri varsayılan kullanıcı görünümünde
ikincil detaydır; ana adımlar `Kimliğini doğrula`, `USDC'yi hazırla`, `Kurunu
sabitle`, `Ödemeyi onayla`, `Teslimatı takip et` olarak gösterilir.

## 10. Durable veri modeli

Production PostgreSQL tabloları:

### `stellar_payment_sessions`

- `id`, `owner_c_account`, `source_network`, `intent_hash`, `state`,
  `provider_id`, `lane`, `created_at`, `expires_at`, `version`.
- Raw prompt ve PII tutulmaz.

### `stellar_provider_routes`

- `session_id`, `provider_manifest_hash`, indicative quote tuple, observed block
  / time, response hash, unavailable reason.

### `stellar_anchor_auth_sessions`

- `session_id`, `provider_id`, `subject`, `token_ciphertext`, `token_hash`,
  `expires_at`, `key_version`.
- JWT loglanmaz; expiry sonrası ciphertext silinir.

### `stellar_anchor_customers`

- Anchor customer reference, KYC status ve required field adları.
- Field values/PII tutulmaz.

### `stellar_firm_quotes`

- Quote ID, provider, exact assets/amounts/fees, expiry, response hash,
  consumed state.

### `stellar_cctp_funding`

- Source chain/domain, destination domain 27, owner C-account, burn tx, message
  hash, nonce, attestation hash, mint tx, atomic amounts ve decimal conversion.

### `stellar_anchor_withdrawals`

- Provider transaction ID, quote ID, status, anchor account, memo type,
  redacted destination, Stellar tx, external tx, refund summary.

### `stellar_payment_events`

- Append-only canonical events, previous-event hash, evidence source, observed
  timestamp, payload hash.

### `stellar_payment_idempotency`

- `(session_id, operation, idempotency_key)` unique.
- Aynı key farklı payload hash ile gelirse conflict.

SQLite yalnız local development için persistent file olarak kullanılabilir;
`:memory:` finansal lifecycle için reddedilir.

## 11. Relayer güvenliği

Mevcut proxy yalnız bounded payload shape kontrol ettiği için production için
yeterli değildir. Yeni relayer policy şunları uygular:

- exact Testnet/Mainnet passphrase,
- source C-account binding,
- accepted account WASM hash,
- invocation target/function allowlist,
- USDC SAC exact identity,
- amount/session cap,
- anchor G/M destination binding,
- Soroban auth tree'de beklenmeyen sub-invocation reddi,
- resource fee ve total fee cap,
- ledger expiry,
- unique nonce/idempotency,
- per-account/global sponsor budget,
- submit sonrası aynı hash ile recovery,
- structured audit log; auth/JWT/PII redaction.

Reference SDF relayer yalnız Testnet development fallback olarak etiketlenir.
Mainnet için Kletia'nın kontrollü fee payer'ı veya sözleşmeli audited operator
gerekir.

## 12. Eski yapı için koru / labs / kaldır matrisi

| Yapı | Karar | Gerekçe |
| --- | --- | --- |
| Stellar portfolio/payment/SDEX | Koru | Gerçek native ağ yeteneği |
| Passkey C-account | Koru ve sertleştir | Payment Passport'un kimlik/authorization temeli |
| CCTP exact message/evidence kodu | Ayıkla ve yeniden kullan | Multichain USDC funding için gerekli |
| Workflow V2 Arc->Arbitrum executor | Koru | Stellar ürününden bağımsız gerçek finansal executor |
| Solver market | Labs | Tek gerçek solver olmadan kullanıcı sonucu üretmiyor |
| V1/V2 control plane ve policy registry | Labs | Foreign execution proof'u değil |
| Policy circuits/V3/V4 generic workflow | Labs | Payment MVP kritik yolunu büyütüyor |
| Stellar Private Payments | Labs | XLM/EURC alpha; USDC payout'a bağlı değil |
| MPP | Labs | Payment Center outcome'una bağlı değil |
| Aquarius comparison | Native tool içinde read-only | Execution kimliği pinlenmedikçe route değil |
| `lastMile.ts` SEP-31-only tasarım | Refactor | Kullanıcı MVP'si için yanlış protokol |
| Core Render'daki labs env/DB | Kaldır | Varsayılan release'i karmaşıklaştırıyor |
| Labs build/test | Ayrı pipeline | Araştırma kanıtını kaybetmeden core'u sadeleştirir |

Silme sırası:

1. Default UI/navigation/import'tan çıkar.
2. API routes `STELLAR_LABS_ENABLED` arkasında 404 verir.
3. Core build artifact ve env bağımlılığı kaldırılır.
4. Deployment/tx/hash manifestleri `docs/research/archive` altında korunur.
5. İki release boyunca import/telemetry kullanımı sıfırsa kaynak kod için ayrı
   delete PR hazırlanır.
6. Deployed Testnet kontratları "aktif ürün" olarak anlatılmaz; zincirde
   silinemeyecekleri belgelenir.

## 13. Faaliyet paketleri

### Faz 0 — Gerçeklik düzeltmesi ve release izolasyonu

Etkilenecek alanlar:

- `README.md`
- `docs/networks/stellar/instaward-proposal.md`
- `docs/networks/stellar/payment-center-architecture.md`
- `apps/api/src/networks/stellar/lastMile.ts`
- `apps/api/src/networks/stellar/routes.ts`
- `apps/api/src/index.ts`
- `render.yaml`, API/web `.env.example`
- root `package.json` verify scripts

İşler:

1. SEP-24'ü direct-user MVP, SEP-31'i partner-only olarak düzelt.
2. Default UI'daki yanlış `SEP-31 payout` vaatlerini kaldır.
3. Labs API/build/env/database yüzeyini core release'ten ayır.
4. Base ve Arc endpoint/import/testlerinin değişmediğini snapshot testle kanıtla.
5. Yeni architecture decision record ekle.

Çıkış kriteri:

- Default release yalnız gerçek Payment Center ve native Stellar araçlarını
  advertise eder.
- Core build labs artifact istemez.
- SEP-31 partner capability olmadan execution-ready olamaz.
- Base/Arc typecheck, build, compile ve intent matrix aynı sonucu verir.

### Faz 1 — Provider registry ve canlı capability census

1. SEP-1 parser'ı SEP-24/6/38/45/59 alanlarıyla genişlet.
2. Provider manifest ve quarantine mekanizmasını ekle.
3. Testanchor ile live SEP-24/38/45 compatibility probe çalıştır.
4. USDC issuer, 1–10 Testnet limit, USD/CAD WIRE tuple ve C-account support'u
   evidence dosyasına bağla.
5. En az iki production adayını read-only incele; ticari erişim gerektirenleri
   `partnership_required` olarak işaretle.

Çıkış kriteri:

- Hiçbir mock candidate yok.
- Endpoint drift fail-closed.
- Testanchor reference flow ile real provider flow ayrıştırılmış.
- Bir provider'ın exact C-account memo/event davranışı bilinmiyorsa execution
  kapalı.

### Faz 2 — Payment Passport hardening

1. SDK exact pin.
2. USDC balance + G/C/M transfer.
3. Secondary passkey ekleme/removal/recovery.
4. Relayer policy decoder ve sponsor cap.
5. Browser reset/second-device recovery.
6. Live Testnet unauthorized signer ve tamper testleri.

Çıkış kriteri:

- İki farklı passkey ile aynı C-account restore edilebilir.
- Silinen signer işlem yapamaz.
- Exact USDC SAC dışındaki transfer reddedilir.
- M-address memo binding canlı transfer event'inde görülür.
- Relayer beklenmeyen contract invocation'ı submit etmez.

### Faz 3 — SEP-45 session client — kodlandı, canlı kullanıcı kanıtı bekliyor

1. Challenge GET proxy ve strict XDR parser.
2. Root invocation `web_auth_verify`; sub-invocation yok; exact account,
   home domain, web-auth domain, signing account, client domain, network ve nonce
   kontrolü.
3. Browser passkey auth-entry signing.
4. Signed entry POST ve JWT subject/expiry binding.
5. Encrypted TTL token store ve forced re-auth.
6. Tampered challenge/domain/account/replay adversarial tests.

Çıkış kriteri:

- Testanchor, ekranda görünen aynı C-address için canlı JWT verir.
- Challenge replay ve başka C-account subject reddedilir.
- JWT log/storage/browser history'de düz metin bulunmaz.

Mevcut durum (1 Eylül 2026): strict challenge/XDR/auth-entry/JWT doğrulaması,
purpose-bound şifreli token saklama ve adversarial testler kodlandı. SDF
Testanchor challenge'ı canlı olarak doğrulandı; fakat aynı C-address için
kullanıcı passkey'iyle alınmış canlı JWT release evidence'ı henüz yoktur.

### Faz 4 — SEP-38 firm quote + SEP-24 withdrawal — kodlandı, funded lifecycle bekliyor

1. Indicative adapter'ı `context=sep24` yap.
2. Authenticated firm quote ekle.
3. Hosted withdraw başlat; popup origin/state doğrula.
4. Status polling ve page-refresh recovery.
5. `pending_user_transfer_start` sonrası exact SAC transfer hazırla.
6. `id` memo -> M-address binding.
7. CAP-67/Horizon asset event ve anchor transaction status'unu birlikte
   doğrula.
8. `completed`, `refunded`, `expired`, `on_hold`, `pending_external`, `error`
   durumlarını ayrı UX'e bağla.

Çıkış kriteri:

- Passkey C-account ile testanchor SEP-24 withdrawal baştan sona canlı Testnet
  lifecycle geçirir.
- Anchor transferi exact tx/event üzerinden görür.
- Sayfa kapanıp açıldığında aynı transaction ID'den devam eder.
- Timeout aynı USDC transferini tekrar göndermez.
- Evidence etiketi açıkça `reference_anchor_testnet`; gerçek banka payout
  iddiası yoktur.

Mevcut durum (1 Eylül 2026): authenticated firm quote, hosted withdrawal,
transaction polling, `pending_user_transfer_start` kapısı, `id` memo -> M-address
dönüşümü, exact SAC transfer/event evidence ve duplicate-send recovery
kodlandı. Testanchor `context=sep24` quote tuple'ını kabul etmediği ve gerçek
payout sağlamadığı için çıkış kriterleri tamamlanmış sayılmaz; özellik compatible
reviewed provider yokken fail-closed kalır.

### Faz 5 — Multichain CCTP funding

1. Existing V2 CCTP binding kodunu payment-center adapter'ına ayıkla.
2. Arc Testnet -> Stellar ve desteklenen EVM Testnet -> Stellar C-account route.
3. Source approval/burn, Iris attestation, Stellar `mint_and_forward` ayrı
   checkpointler.
4. EVM 6 decimal -> Stellar 7 decimal exact dönüşüm testleri.
5. Destination C-account ve hook-data doğrulaması.
6. Pre-fund varsayılanı; JIT route TTL risk kapısı.

Çıkış kriteri:

- Kullanıcı EVM wallet'ı burn'u, passkey ise anchor payment'ı ayrı imzalar.
- Exact burn nonce/message ile Stellar mint eşleşir.
- Duplicate burn/mint replay reddedilir.
- CCTP complete olup payout başarısızsa fon C-account'ta kullanıcıya ait kalır.
- Base/Arc ana DeFi intent akışları değişmez.

### Faz 6 — Gerçek partner ve SEP-31 koridoru

Bu faz teknik geliştirmeden önce iş/uyum bağımlılığıdır.

1. Sending-anchor partner veya Kletia'nın yasal sending-anchor rolü belirlenir.
2. Receiving anchor ile bilateral agreement ve auth G-account kaydı alınır.
3. Organizational SEP-10 key yalnız partner KMS/HSM veya Kletia KMS'de tutulur;
   browser/desktop txt dosyasına yazılmaz.
4. User C-account authorization ile organization SEP-10 session ayrı kaydedilir.
5. Sender/receiver SEP-12 customer model, refund destination ve support SLA
   sözleşmeye bağlanır.
6. SEP-31 status/refund evidence adapter'ı eklenir.

Çıkış kriteri:

- Gerçek partner ortamında düşük değerli delivery veya doğrulanmış regulated
  sandbox sonucu.
- Refund, partner hesabında kalmaz; sözleşmeli biçimde user C-account/source'a
  döner ve kanıtlanır.
- Partner olmadan endpoint `partnership_required` kalır.

### Faz 7 — SEP-59 Payment Passport ingress araştırması

1. Provider census.
2. C-account SEP-45 provisioning proof.
3. Idempotent virtual/bank/crypto account lifecycle.
4. PII/instruction storage boundary.
5. CAP-67 credit reconciliation.

Çıkış kriteri:

- Çalışan provider yoksa ürün yüzeyine alınmaz.
- Draft spec değişimi manifest version gate'ini kapatır.
- Bu faz off-ramp MVP'sini bloke etmez.

### Faz 8 — Production readiness

- Independent smart-account/relayer integration audit.
- Mainnet exact contract/issuer/domain manifests.
- KMS key rotation ve disaster recovery.
- PostgreSQL HA, encrypted backup, point-in-time recovery.
- Provider health/SLA/incident monitoring.
- Sanctions/KYC/legal review ve country availability policy.
- Fee sponsor abuse controls.
- Support/refund runbook.
- Small-value canary, spend caps ve emergency disable.

Production çıkış kriteri audit, operasyon, partner ve funded evidence birlikte
sağlanmadan verilemez.

## 14. Test matrisi

### Parser/intent

- Kısa, uzun, Türkçe, İngilizce, typo içeren payment intentleri.
- Own off-ramp ile third-party payout ayrımı.
- Pure DeFi'nin Stellar'a yönlenmemesi.
- Private amount placeholder ve clarification.
- Country/currency/rail ambiguity.

### Provider güvenliği

- Redirect, DNS rebinding, private IP, credential URL, oversized body.
- TOML endpoint drift.
- Wrong issuer/SAC/network.
- Unsupported delivery tuple.
- Stale indicative/firm quote.
- Unknown status.

### SEP-45

- Wrong account/domain/network/client domain.
- Sub-invocation injection.
- Nonce replay.
- Expired challenge/JWT.
- Another credential signer.
- Oversized/malformed XDR.

### Passkey/SAC

- Create/connect/second signer/remove/recover.
- User cancellation.
- G/C/M recipient.
- id memo conversion.
- Wrong memo type.
- Wrong token/amount/recipient.
- Relayer timeout before and after submission.

### SEP-24 lifecycle

- Popup blocked/closed.
- Hosted flow cancel.
- `incomplete` -> `pending_user_transfer_start`.
- `pending_external`, `on_hold`, `completed`.
- `refunded`, `expired`, `error`.
- Refresh/restart/re-auth.
- Duplicate button/input.

### CCTP

- Source chain/domain mismatch.
- 6/7 decimal loss.
- Wrong destination/hook.
- Incomplete attestation.
- Used nonce.
- Mint complete, payout not started.
- Burn indeterminate recovery.

### Regression

- Base swap/lending/x402.
- Arc swap/lending/staking/vault.
- Arbitrum quote/lending.
- Existing Arc -> Arbitrum executor.
- Light/dark/mobile/chat card design.

## 15. Evidence seviyeleri

| Seviye | İzin verilen iddia |
| --- | --- |
| E0 | Kodlandı; unit/schema/build geçti |
| E1 | Canlı provider discovery/auth/quote görüldü; fon yok |
| E2 | Testnet onchain fon ve reference anchor lifecycle tamamlandı |
| E3 | Regulated partner sandbox delivery/refund tamamlandı |
| E4 | Düşük değerli gerçek external payout tamamlandı |
| E5 | Audit + operasyon + mainnet canary tamamlandı |

E2 hiçbir zaman "gerçek banka payout production-ready" anlamına gelmez.
Transaction hash tek başına delivery kanıtı değildir.

## 16. Rollback ve migration

- Yeni Payment Center ayrı route namespace ve feature flag ile çıkar.
- Mevcut native Stellar payment/SDEX yolları değişmeden kalır.
- `last-mile` quote facade bir release boyunca read-only compatibility sağlar.
- Yeni state schema version'lıdır; eski V2/V3/V4 workflow state'i migrate
  edilmez veya yeni payment session olarak yorumlanmaz.
- Provider drift veya incident halinde yalnız ilgili provider quarantine olur;
  Stellar native ve Base/Arc çalışmaya devam eder.
- Relayer incident halinde yeni sponsored submission kapanır; mevcut tx hash
  recovery açık kalır.
- CCTP incident halinde source funding kapanır; Stellar'da mevcut USDC ile
  direct off-ramp çalışabilir.
- Anchor incident halinde yeni firm quote/withdrawal kapanır; mevcut transaction
  polling/refund recovery açık kalır.

## 17. Kill kriterleri

Şu koşullardan biri gerçekleşirse ilgili özellik durdurulur veya yeniden
tasarlanır:

1. C-account SAC transferini exact memo/asset event ile gözleyen provider yoksa
   passkey off-ramp execution açılmaz.
2. Canlı provider SEP-45 desteği ilan edip çalışan C-account session vermezse
   provider quarantine olur.
3. Testnet reference flow dışında regulated partner yolu bulunamazsa gerçek
   payout iddiası yapılmaz.
4. CCTP quote TTL içinde güvenli funding sağlayamıyorsa JIT bridge kaldırılır,
   yalnız pre-fund kalır.
5. Recovery signer güvenli biçimde uygulanamazsa para limiti düşük tutulur veya
   funded C-account kapatılır.
6. Yeni özel kontrat ancak official contract/account kit ile çözülemeyen açık
   bir gereksinim, formal threat model ve audit bütçesi varsa deploy edilir.

## 18. İlk uygulama sırası

Plan onaylandıktan sonra kodda izlenecek exact sıra:

1. README/proposal/architecture SEP-24/SEP-31 düzeltmesi.
2. `lastMile.ts` için SEP-24-first refactor ve backward-compatible quote facade.
3. Provider manifest schema + Testanchor manifest/evidence.
4. Core Render/env'den labs bağımlılıklarını temizleme.
5. Smart Account Kit exact pin.
6. Passkey USDC balance + G/C/M transfer ve memo conversion.
7. Relayer decode/allowlist/idempotency policy.
8. SEP-45 client ve adversarial testler.
9. Firm SEP-38 quote.
10. SEP-24 hosted withdrawal/state recovery.
11. Live Testnet C-account withdrawal evidence.
12. CCTP pre-fund adapter.
13. Full core regression ve UI journey.
14. Partner/SEP-31 ayrı workstream kararı.

Her madde kendi acceptance gate'ini geçmeden sonraki para taşıyan madde
execution-ready yapılmayacaktır.

## 19. Beklenen nihai anlatım

Kletia'nın kısa, doğru ve savunulabilir Stellar anlatımı şudur:

> Kletia AI ile kullanıcının çok zincirli finansal hedefini anlar; Stellar ile
> bu hedefe passkey kontrollü, sağlayıcıdan bağımsız bir ödeme kimliği ve gerçek
> dünya giriş/çıkış yaşam döngüsü kazandırır. Base ve Arc DeFi'yi yürütür;
> Stellar, USDC'nin bir blockchain varlığından takip edilebilir bir ödeme
> sonucuna dönüştüğü yerdir.

Bu anlatım passkey'i tek başına özgünlük diye sunmaz. Stellar'ın vazgeçilmezliği;
passkey C-account, SAC/CAP-67 asset events, Circle USDC/CCTP ve anchor SEP
standartlarının aynı ödeme lifecycle'ında birleşmesinden gelir.
