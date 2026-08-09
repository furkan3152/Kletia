# Kletia Omni-Engine

Kletia, Base Mainnet ve Arc Testnet için tek uygulama kabuğu kullanan,
ağ-bağlamlı bir Web3 niyet motorudur. Aktif ağ değiştiğinde cüzdan zinciri,
niyet ayrıştırıcı, işlem hedefleri, widget’lar, varlık adları ve uygulama
durumu birlikte değişir.

## Desteklenen ağlar

| Profil | Ağ | Gas / native varlık | USDC | Ağ özellikleri |
| --- | --- | --- | --- | --- |
| `base` | Base Mainnet (`8453`) | ETH | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimal) | Base rota motoru, Basename, Allora, Airdrop, x402 ve Webacy. Agent modu imzalı sahiplik eklenene kadar kapalıdır. |
| `arc` | Arc Testnet (`5042002`) | Native USDC | Native/RPC işlemlerinde 18 decimal; kullanıcı gösteriminde 6 decimal. ERC-20 arayüzü: `0x3600000000000000000000000000000000000000` | Arc swap, vault, staking, lending, liquidity, batch ve memo |

Base’in halka açık RPC’si üretim için rate-limitlidir. Üretimde sunucu tarafındaki
`BASE_RPC_URL` için özel bir sağlayıcı kullanın. `VITE_BASE_RPC_URL` tarayıcı
bundle’ına gömüldüğü için gizli CDP Node URL/key içermemeli; yalnız public veya
domain-kısıtlı bir istemci RPC’si olmalıdır. Arc
ayarları [Arc bağlantı belgeleri](https://docs.arc.io/arc/references/rpc-endpoints),
Base ayarları [Base bağlantı belgeleri](https://docs.base.org/base-chain/quickstart/connecting-to-base)
ile uyumludur.

## Canonical uygulama

- Frontend: `frontend/base_mainnet`
- Backend: `backend/base_mainnet`
- Deploy tanımı: `render.yaml`

`arc_testnet` klasörleri eski ayrık uygulamanın referans kopyalarıdır. Birleşik
uygulamayı çalıştırmak veya deploy etmek için canonical dizinler kullanılmalıdır.
Yanlışlıkla eski ağı ayağa kaldırmamak için legacy `start`, `dev` ve `preview`
komutları açık bir deprecation hatasıyla durur. Bu birleşim kontrat kaynaklarını
ya da deploy edilmiş kontratları değiştirmez.

## Güvenlik ve ağ izolasyonu

- Uygulama modu yalnız cüzdanın gerçek zincir değişimi başarılı olduktan sonra
  güncellenir.
- Her niyet isteği `network`, `chainId`, `requestId` ve kullanıcı cüzdanı ile
  etiketlenir; backend farklı ağ/chain eşleşmesini reddeder.
- Base ve Arc konuşmaları ayrı store kovalarında tutulur. Persist edilen geçmiş
  calldata, rota, allowance veya işlem hash’i içermez.
- Çok adımlı açıklama bağlamı cüzdan adresiyle ortak bir belleğe yazılmaz;
  tahmin edilemez, kısa ömürlü ve ağ+cüzdana bağlı bir konuşma kimliği kullanır.
- Arc hedefleri deploy manifest allowlist’i ve canlı RPC bytecode kontrolünden;
  Base hedefleri aksiyon-bazlı execution allowlist’i ve Webacy politikasından
  geçer. Güvenlik servisi doğrulama yapamazsa işlem fail-closed durur.
- Approval ve son işlem gerçek hesap/hedef/calldata/value ile simüle edilir.
  Approval gerektiren backend rotası başarılı simülasyon gibi sunulmaz; son
  `eth_call` approval receipt’inden sonra zorunludur. Sabit gas fallback’i
  kullanılmaz.
- Transaction hash başarı sayılmaz; receipt alınır ve başarılı status
  doğrulanır.
- Canlı sağlayıcı hataları `0`, boş pozisyon veya tahminî fiyatla
  değiştirilmez; kaynak `partial` ya da `unavailable` olarak gösterilir.

## Gereksinimler

- Birleşik geliştirme/frontend build için Node.js 22.13 veya üzeri (`.nvmrc`: 22.13.0).
  Backend Docker imajı Node 20 üzerinde ayrıca doğrulanır.
- npm
- Base Mainnet ve Arc Testnet destekleyen bir EVM cüzdanı

## Backend

```bash
cd backend/base_mainnet
cp .env.example .env
npm ci --legacy-peer-deps
npm run dev
```

Üretim çalışma biçimini yerelde doğrulamak için önce `npm run build`, ardından
`npm start` kullanın. Docker imajı bu derleme adımını build katmanında yapar ve
final imaja yalnız runtime bağımlılıklarını alır.

Asgari ağ ayarları:

```dotenv
PORT=3001
BASE_RPC_URL=https://your-private-base-rpc.example
ARC_RPC_URL=https://rpc.testnet.arc.network
OPENROUTER_API_KEY=
WEBACY_API_KEY=
CORS_ORIGINS=http://localhost:5174
```

Agent, Allora, CDP/paymaster ve x402 değişkenleri
`backend/base_mainnet/.env.example` içinde açıklanmıştır. Private key, wallet
export’u veya gerçek `.env` dosyası Git’e eklenmemelidir.

Base bridge rotası canlı Across production API’sini kullanır; bu nedenle
`ACROSS_API_KEY` ve 2 baytlık `ACROSS_INTEGRATOR_ID` zorunludur. Ücret tavanı
`ACROSS_MAX_RELAY_FEE_BPS` ile belirlenir. Paymaster proxy her isteğe
sunucu-kontrollü `CDP_PAYMASTER_POLICY_ID` ekler; CDP Portal contract/method
allowlist’i, kullanıcı limitleri ve global harcama tavanı olmadan paymaster
etkinleştirilmemelidir.

## Frontend

```bash
cd frontend/base_mainnet
cp .env.example .env
npm ci --legacy-peer-deps
npm run dev
```

Frontend varsayılan olarak `http://localhost:5174` üzerinde çalışır.

```dotenv
VITE_BACKEND_URL=http://127.0.0.1:3001
VITE_BASE_RPC_URL=https://your-public-or-domain-restricted-base-rpc.example
VITE_ALLOW_PUBLIC_BASE_RPC_FALLBACK=false
VITE_ARC_RPC_URL=https://rpc.testnet.arc.network
VITE_WALLETCONNECT_PROJECT_ID=
```

`VITE_WALLETCONNECT_PROJECT_ID` boşsa injected ve Base Wallet bağlantıları
çalışmaya devam eder; WalletConnect/QR seçeneği sahte bir proje kimliğiyle
başlatılmaz.

`VITE_BASE_RPC_URL` production build için zorunludur. Eksik bırakılırsa
uygulama, rate-limitli genel Base RPC'ye sessizce düşmek yerine başlangıçta
fail-closed olur. Render ortamında `sync: false` olan bu değişkeni deploy
öncesinde tanımlayın. Eski bir yerel `.env` kullanıyorsanız Arc değeri de
`https://rpc.testnet.arc.network` olmalıdır.

## Doğrulama

```bash
cd backend/base_mainnet
npm run typecheck
npm run build
npm run test:network
npm run verify:base-registry
npm test

cd ../../frontend/base_mainnet
npm run lint
npm run build
node --test tests/useTransactionExecutor.test.mjs
```

`test:network`, ağ/chain eşleşmesini ve Base–Arc hedef izolasyon sözleşmesini
kontrol eder. `verify:base-registry`, Base Mainnet üzerinde yalnız salt-okunur
bytecode, piyasa ve likidite keşfi yapar; işlem göndermez. Canlı zincir
işlemleri için yalnız test cüzdanı kullanın; mainnet anahtarını Arc testlerinde
veya istemci tarafında kullanmayın.

Base protokol kapsamı, resmi adres kaynakları ve Fee Router allowlist kararları
`docs/base-defi-protocol-registry.md` içinde tutulur. Mimari özet için
`docs/Kletia_Architecture_OnePager.md` belgesine bakın.

## Deploy

`render.yaml`, canonical frontend ve backend dizinlerini deploy eder. Üretim
ortamında en az özel Base RPC, frontend URL’sini içeren `CORS_ORIGINS` ve
kullanılan canlı servislerin API anahtarları tanımlanmalıdır. QR bağlantısı
sunulacaksa WalletConnect project ID de gerekir. Paymaster kullanılacaksa CDP
Portal tarafında contract/method allowlist’i ile harcama limitleri ayrıca
zorunlu savunma katmanı olarak yapılandırılmalıdır.
