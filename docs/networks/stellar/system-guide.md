# Kletia Stellar System Guide

Bu belge, Stellar yönünün Kletia’ya ne eklediğini ve kullanılan kavramların neden gerekli olduğunu ürün sahibi gözüyle açıklamak için hazırlanmıştır. Bir deployment kanıtı değildir. Aşağıda “mevcut” denilenler bugünkü kod tabanını, “MVP” ve “sonraki aşama” denilenler ise henüz uygulanmamış ürün kararlarını ifade eder.

## Kletia bugün nedir?

Kletia, doğal dilde verilen bir hedefi ağ, varlık, protokol, miktar, alıcı, maliyet ve risk kısıtlarına ayırıp güvenli bir işlem planına dönüştürmeye çalışan niyet odaklı bir Web3 uygulamasıdır. Mevcut uygulama EVM merkezlidir. Ortak API ve web uygulaması Base, Arc ve capability flag arkasındaki Arbitrum profillerini tanır; adresleri EVM `0x` adresi, ağları numeric chain ID ve yürütmeyi calldata mantığıyla modeller. Base Mainnet ve Arc Testnet aynı arayüzde bulunur ancak ağ kuralları birbirinden ayrıdır. Arbitrum kodu Public Beta olarak vardır; production ortamında etkinlik ve readiness ayrıca doğrulanmalıdır.

Stellar artık yalnız planlanan bir adapter değildir. Kod tabanında tagged
Stellar/EVM ağ, adres ve varlık tipleri; Horizon/RPC readiness; XLM/Circle
Testnet USDC portföyü ve trustline hazırlığı; Freighter ile exact Testnet XDR;
SDEX path-payment yürütmesi; read-only Aquarius karşılaştırması; Arc–Stellar–
Arbitrum Sepolia CCTP/Aave V2 workflow'u; V3 privacy/control-plane planlama ve
resmî MPP Charge sunucu yolu vardır. Ancak bunların release seviyeleri aynı
değildir: Aquarius execution, MPP session, confidential treasury, V3 generic
exact-call advance ve üç yeni Soroban control-plane kontratı deploy edilip
kanıtlanana kadar fail-closed kalır. Bu ayrım “kodlandı”, “deploy edildi”, “canlı
test edildi” ve “production-ready” iddialarını birbirine karıştırmaz.

## Kletia bugün neler yapabiliyor?

Kletia’nın özelliği yalnız chat ekranı değildir. Widget’lar düzenlenebilir doğal dil örneği üretir ve ana prompt ile aynı parser/routing hattına girer. Sistem token sembolü, adresi, alias’ı ve cüzdan bakiyesini çözebilir; belirsiz varlık, ağ, protokol veya alıcıda tahmin ederek işlem üretmek yerine açıklama ister. Hazırlanan cevap aktif ağ, chain ID, cüzdan ve request kimliğine bağlanır. Token harcaması gereken işlemlerde approval hedefi ayrıca gösterilir; desteklenen rotalarda simülasyon ve receipt kontrolü yapılır. Provider hatası sıfır bakiye, sahte APY veya başarılı işlem gibi gösterilmez.

| Profil | Bugünkü kod yüzeyi | Dürüst release sınırı |
|---|---|---|
| Base Mainnet | Portföy; swap quote karşılaştırması; likidite ekleme/çıkarma; Aave, Moonwell ve Compound lending/borrowing/repay/withdraw; staking ve liquid staking; ERC-4626 vault/getiri karşılaştırması; Across bridge; Basename; token launch; Allora; Webacy; airdrop simülasyonu; x402 discovery, buyer ve seller araçları | Bazı protokol adresleri discovery-only’dir. Paymaster, Launch V2 ve Router V2 gibi yollar environment/evidence moduna bağlıdır. Adresin kayıtlı olması o işlemin executable olduğu anlamına gelmez. |
| Arc Testnet | Native USDC’ye özgü portföy; Kletia swap, vault, staking, lending, memo, atomic batch payout ve liquidity kontratları; EURC/cirBTC/KLET çözümleme; Circle App Kit send/bridge ve stable-swap planları | Testnet’tir. Base likiditesi veya mainnet ekonomik sonucu gibi sunulamaz. Vault sürümü environment moduna bağlıdır. Circle SDK yolu Kletia’nın standart EVM transaction executor’ıyla aynı değildir. |
| Arbitrum One | ETH/WETH/USDC/ARB portföyü; transfer; Uniswap V3 fee-tier quote/swap; Aave V3 supply, withdraw, borrow, repay, yield ve risk tamponlu borrow capacity; Across ile Base→Arbitrum workflow ve gas-acquisition planı | Public Beta ve capability-gated’dir. API ve web flag’i, RPC chain attestation ve protokol readiness birlikte geçmeden production özelliği değildir. |
| Cross-chain | HMAC-sealed `WorkflowPlanV1`; receipt/fill/refund checkpoint’i; resume/advance; önceki adımın kanıtlanmış çıktısını sonraki adıma bağlama; her finansal adımda ayrı kullanıcı onayı | Global atomik değildir. Timeout sonrası otomatik tekrar yoktur; belirsiz sonuç `indeterminate` kalır. Arc Testnet mainnet workflow’una katılmaz. |
| Policy ve güvenlik | Planlama yetkisi veren `PolicyAgentV1`; network/request/wallet binding; token/entity evidence; prompt secret filtresi; Webacy kontrolleri; approval review; action-specific simulation | PolicyAgent imzası para harcama yetkisi değildir. Güven skoru hard gate’leri geçersiz kılamaz. Her external/SDK yüzeyi aynı simülasyon tekniğini kullanamayabilir. |

Bu tablo “kod dosyası var” ile “her production ortamında çalışıyor” ayrımını korur. Bir özelliğin release iddiası için doğru environment, canlı provider, aktif kontrat modu, wallet uyumluluğu ve uçtan uca kanıt birlikte gerekir.

## Kletia'nın Güvence Haritası

Kletia'nın ürünü bir sohbet cevabı değil, doğal dil ile imzalanabilir işlem arasındaki anlamı koruyan bir yürütme kontrol katmanıdır. Bunun sınırı açıkça belirtilmelidir: hiçbir LLM çıktısı, quote, simülasyon veya güven puanı tek başına “güvenli işlem” garantisi vermez. Her katman yalnız kendi kanıtını üretir ve başka bir katmanın görevini devralamaz.

| Katman | Uygulayan mekanizma | Sağladığı güvence | Sağlamadığı güvence | Hata davranışı |
|---|---|---|---|---|
| Niyet çıkarımı | LLM + şema doğrulama | Amaç, kısıt ve belirsizlik adaylarını çıkarır | Doğru asset, kontrat, XDR veya calldata | Belirsiz alan için kullanıcıya yapılandırılmış soru |
| Anlam kaybı kontrolü | Deterministik `SemanticInvariantSetV1` | Bir sonraki temsilde kısıtın düşmesini, genişlemesini veya sessizce değişmesini engeller | Piyasa sonucunu veya protokol güvenliğini garanti etmez | Planı fail-closed durdurur ve değişen alanı gösterir |
| Varlık kimliği | Code+issuer, trustline, SAC ve kaynak kanıtı | İmzalanacak varlığın çözümlenen varlıkla aynı olduğunu gösterir | Issuer'ın ödeme gücünü veya itfa vaadini garanti etmez | Varlığı yürütülemez işaretler |
| Quote | Canlı provider sonucu + gözlem ledger'ı + expiry | O anda gözlenen rota ve ekonomik sınırları gösterir | Gelecekteki kesin çıktı veya fill garantisi değildir | Expiry'de yeniden quote ve yeniden onay |
| Classic yürütme | XDR, sequence, timebounds ve imzalar | Aynı Classic transaction içindeki 1–100 operation'ın atomik sonucunu verir | Soroban çağrısıyla ortak atomiklik veya cross-chain kesinlik sağlamaz | Başarısız transaction'da tüm Classic operation'lar geri alınır |
| Soroban yürütme | RPC simülasyonu, footprint, resource fee ve auth invocation tree | Tek host-function operation içindeki iç içe kontrat çağrılarını atomik bağlar | Simülasyonun gelecekteki ledger sonucunu garanti etmez | Simülasyon/kimlik ağacı değişirse yeniden hazırlama ve imza |
| C-account policy | `__check_auth`, kayıtlı delegate ve on-chain limitler | Yalnız C hesabında tutulan fonlar için hedef, fonksiyon, asset, tutar ve zaman politikasını uygular | G hesabı, Classic operation veya başka ağ fonları üzerinde yetki kurmaz | Policy uyuşmazlığında auth reddi |
| Cross-chain workflow | Mühürlü checkpoint, fill/refund kanıtı ve adım durumu | Her adımın önceki kanıtlanmış sonuca bağlı olduğunu gösterir | Global atomiklik sağlamaz | `failed`, `refunded` veya `indeterminate`; sessiz yeniden gönderim yok |
| Execution receipt | Ledger operation/event ve balance delta | Beklenen etkinin gözlenen zincir sonucu ile eşleştiğini gösterir | Ekonomik kârlılık veya dış verinin doğruluğu değildir | Uyuşmazlıkta başarı etiketi üretmez |
| Ücretli veri | x402/MPP settlement receipt'i | Ödemenin doğru asset, alıcı ve sınırla gerçekleştiğini kanıtlar | Satın alınan verinin doğru veya güvenilir olduğunu kanıtlamaz | Veri güvenilmeyen girdi olarak kalır |

### Semantic-loss detector neden ürün çekirdeğidir?

Kletia her dönüşüm sınırında aynı anlam kümesini karşılaştırmalıdır: kullanıcı cümlesi → yapılandırılmış niyet → asset/alıcı/protokol bağları → quote → XDR veya Soroban auth ağacı → ledger receipt'i. Korunan alanlar en az ağ ve network passphrase, source account ve hesap türü, kesin varlık kimliği, miktar veya üst sınır, minimum çıktı/slippage, alıcı, memo/muxed ID, izinli protokol/kontrat/fonksiyon/hop'lar, geçerlilik aralığı, gerekli imza politikası ve beklenen etkileri kapsar.

Bu kontrol yalnız JSON alanlarını karşılaştırmak değildir. Örneğin “resmî USDC” niyetinde issuer'ın düşmesi, strict-receive talebinin strict-send'e çevrilmesi, federation çözümünden sonra memo'nun kaybolması, quote alıcısıyla XDR alıcısının ayrışması veya yalnız Aquarius'a izin veren bir C-account politikasında nested invocation ağacına başka hedef eklenmesi anlam kaybıdır. Sistem bu farkı “yakın eşleşme” sayıp para hareketi üretmez. Cüzdan, ağ, route, quote veya çözümleme sonucu değiştiğinde önceki onay da geçersiz sayılır.

## Kletia normal bir agent’tan gerçekten farklı mı?

Objektif cevap iki parçalıdır. Doğal dille swap, bridge, lending ve çok adımlı DeFi hazırlamak artık özgün değildir. Ağustos 2026’da Brian, HeyAnon, Bankr, NEAR Intents ve Coinbase AgentKit gibi ürünler bu alanın farklı bölümlerinde Kletia’dan daha geniş chain/protokol desteğine, daha güçlü dağıtıma veya geliştirici ekosistemine sahiptir. Bu nedenle “AI + multichain + swap” Kletia’nın savunulabilir iddiası olamaz. Alan kalabalıktır, fakat bütün kategorilerde tek ve baskın bir kazanan bulunduğu için saturated saymak da doğru değildir.

Kletia’nın bugünkü anlamlı farklılığı şunların birleşimidir:

- Ağ değişimini yalnız RPC seçimi olarak görmeyip parser, asset registry, native gas, widget, target policy ve executable state’i birlikte değiştirmesi.
- LLM’yi calldata veya contract adresi üreticisi değil, hedef ve belirsizlik çıkarıcısı olarak sınırlaması.
- Basit işlemler ile cross-chain workflow’ları aynı güvenlik sınırına bağlarken global atomiklik iddia etmemesi.
- Quote, wallet, network, request, spender, recipient ve receipt kanıtlarını yürütme sözleşmesinin parçası yapması.
- Base x402, Arc native-USDC/App Kit ve planlanan Stellar x402/MPP gibi ağ-yerel özellikleri tek bir sahte genel protokole dönüştürmemesi.

Bunlar ürünün “AI wrapper” olmaktan çıkması için iyi bir temel sağlar, ancak tek başına güçlü moat değildir. Kod açık kaynakta taklit edilebilir; bugün Kletia’nın solver ağı, kendine ait likiditesi, geniş dış SDK kullanımı, yüksek işlem hacmi veya kanıtlanmış güven markası yoktur. Gerçek savunulabilirlik ancak dApp/cüzdan entegrasyonları, büyüyen receipt verisi, güvenlik geçmişi ve geliştiricilerin Kletia manifest sözleşmesine bağımlı hale gelmesiyle oluşur.

Stellar entegrasyonu da otomatik olarak özgünlük yaratmaz. Horizon/RPC, Aquarius, x402, MPP, passkey ve smart account herkesin kullanabildiği yapılardır; resmî Stellar agentic-payment araçlarını çağıran bir chatbot yeni bir kategori değildir. Kletia'yı ayrıştırabilecek katman, bunların üzerinde çalışan ağdan bağımsız ama ağ semantiğini kaybetmeyen execution control plane'dir: issuer-aware resolver, G/C dual rail, çok kaynaklı quote karşılaştırması, semantic-loss detector, mühürlü manifest ve zincir etkisine bağlı receipt. Özgünlük protokol isimlerinin sayısından değil, aynı kullanıcı kısıtının metinden imzaya ve receipt'e kadar ölçülebilir biçimde korunmasından gelir.

## SEP’lere neden ihtiyaç var ve bugünkü sürümden farkı ne?

Bugünkü Kletia EVM merkezlidir: ağ numeric chain ID, hesap `0x` adresi, token chain+contract address ve işlem target+calldata ile tanımlanır. Protokol kayıtları çoğunlukla kod içinde review edilmiş adreslerden gelir. Connected wallet adresi işlem öncesi yeniden kontrol edilir; fakat Kletia'nın Stellar'a özgü domain discovery, asset identity veya servis oturumu sınırı yoktur.

SEP'ler Kletia'ya kendiliğinden yeni finansal özellik veya güven garantisi üretmez; cüzdan, issuer, anchor ve servislerin aynı veri sözleşmesiyle konuşmasını sağlar. Bu nedenle yalnız somut kullanıcı akışının gerektirdiği SEP uygulanmalıdır:

- SEP-1, issuer veya servisin `stellar.toml` içinden yayınladığı capability ve endpoint bilgisini keşfetmek için değerlidir. Bu dosya tek başına güven kaynağı değildir; domain bağı, asset code+issuer ve gerekiyorsa on-chain SAC kaydı ayrıca doğrulanır.
- SEP-10, bir web/anchor servisine G veya M hesabıyla kimlik doğrulamak içindir. Freighter bağlamak, normal transaction imzalamak veya genel olarak “cüzdan benim” demek için zorunlu değildir. Kletia ancak resumable server session ya da gerçek bir SEP-10 servis entegrasyonu sunduğunda bunu desteklediğini söylemelidir.
- SEP-45, C hesabının bir web/anchor servisine kimlik doğrulaması içindir; passkey ile Soroban çağrısı imzalamanın önkoşulu değildir ve Ağustos 2026 itibarıyla Draft'tır.
- Federation, muxed account ve memo standartları swap aggregator için şart değildir. İnsan okunabilir ödeme veya saklama hesabı akışına geçildiğinde alıcı anlamını korumak için eklenir.
- SEP-41, Soroban token arayüzünü tanımlar ancak Draft durumundadır; SAC executable ve klasik asset bağının ledger kanıtının yerini tutmaz.

Dolayısıyla ilk Stellar sürümünde SEP sayısı bir başarı metriği değildir. Her standart için “bu çıkarılırsa hangi canlı akış bozulur?” sorusunun ölçülebilir cevabı yoksa o standart çekirdek MVP’ye eklenmez. Bu daraltma mevcut Base/Arc/Arbitrum özelliklerini kaldırmaz; yalnız Stellar release iddialarını uygulanabilir tutar.

## Stellar neden Kletia’nın merkezine uyuyor?

Kletia’nın asıl problemi “chat ile swap” değildir. Kullanıcının tek hedefi; farklı ağlar, varlık tanımları, likidite kaynakları, alıcı biçimleri ve ödeme protokolleri arasında parçalanır. Stellar, bu parçaların büyük bölümüne ağ içinde standart cevaplar sunar:

| Kletia’nın sorunu | Stellar’daki yapı | Kletia’ya kazandırdığı değer |
|---|---|---|
| Entegrasyon adresleri ve servis bilgileri zamanla eskiyor | `stellar.toml` servis keşfi + ledger doğrulaması | Sabit adres listesinden sürümlü, kaynağı görünen capability kaydına geçiş |
| Bir web/anchor servisi çağrıyı hangi hesaba bağlayacağını bilmiyor | SEP-10/45 challenge oturumu | Para harcama yetkisi vermeden servis oturumunu doğru hesap türüne bağlama |
| Aynı sembol farklı issuer’lara ait olabiliyor | Code + issuer + trustline + SAC bağı | Yanlış veya sahte varlığın sessizce seçilmesini engelleme |
| Uzun adres, memo ve saklama hesabı ayrıntıları fon kaybı yaratabiliyor | Federation, muxed account ve memo kontrolü | Okunabilir alıcı deneyimini güvenli hedef bağlamasıyla sunma |
| Tek protokol sonucu “en iyi rota” diye gösteriliyor | SDEX/native liquidity ve Soroban AMM’leri | Aynı ekonomik kısıtlarda gerçek çok kaynaklı teklif karşılaştırması |
| Agent’ın ücretli veri alması gerçek settlement’a bağlı değil | Stellar x402 veya MPP | API/data satın alımını gerçek Stellar ödemesi, kullanıcı tavanı ve receipt ile bağlama; protokolün kendisi Kletia'ya özgü değildir |
| Agent yetkisi ya çok zayıf ya da gereğinden geniş | Contract account policy’leri | İleride varlık, alıcı, tutar ve süreyle sınırlı on-chain yetki |

Stellar bu nedenle Kletia’ya yalnız yeni likidite eklemiyor. Ürünün kimlik, varlık güveni, rota kanıtı, ödeme ve yetkilendirme modelini daha açık bir sözleşmeye dönüştürmek için uygun bir temel sağlıyor.

## Paylaşılan InstAward projelerinden ne öğreniyoruz?

Bu bölümdeki proje tanımları kullanıcının paylaştığı Türkiye InstAward duyurusuna dayanır. Bu çalışma sırasında on proje için ayrı resmî ödül sayfası, repo, demo veya on-chain kanıt bulunamadığı için aşağıdaki tablo bir ürün doğrulaması değil, verilen açıklamalardan çıkarılan kapsam dersidir. Bağımsız doğrulayabildiğimiz program kuralı şudur: InstAward işi açık, ölçülebilir ve normalde otuz gün veya daha kısa bir sprintte tamamlanabilir olmalıdır.

| Paylaşılan proje | Güçlü ürün dersi | Kletia kararı |
|---|---|---|
| Ferry | Bir anchor/remittance ürünü ancak KYC, quote expiry, banka bilgisi, refund ve durum makinesi birlikte çözülünce anlamlıdır | Kletia anchor olmayacak ve SEP-10/12/24/31/38 listesini ilk MVP’ye doldurmayacak. Gerçek bir anchor seçildiğinde bu durumlar capability adapter olarak workflow’a eklenebilir. |
| Corra | Asenkron settlement’ta imzalandı, yayınlandı, onaylandı ve sonucu belirsiz durumları ayrı tutulmalıdır | Kletia’nın mevcut sealed checkpoint ve `indeterminate` modeli Stellar burn, attestation, mint ve delivery yaşam döngüsüne taşınacak. |
| Pairy | Claimable balance, hazır olmayan alıcı ve geri alma süresi için yararlı bir ledger primitive’idir | Genel escrow ürünü yapılmayacak. Yalnız uygun Classic G-account akışında, açık claim/reclaim koşulları ve reserve maliyeti kullanıcı tarafından görülürse fallback olabilir. |
| QuietStay | ZK ancak belirli bir gizlilik iddiası, circuit ve verifier ile ürün değerine dönüşür | İlk MVP’ye ZK eklenmeyecek. Kletia’nın recipient-safe settlement problemi için zorunlu değildir. |
| Dwell | Micropayment’ın değeri, ödeme tetikleyicisinin gerçekten kanıtlanmasına bağlıdır | Reklam/impression oracle’ı kopyalanmayacak. Mevcut Base x402 korunur; Stellar `data_purchase` daha sonra exact cap ve receipt ile ayrı adapter olabilir. |
| Antares | Bir vault yalnız kontrat değil, oracle, lifecycle, settlement ve strateji riski taşır | Yeni covered-call vault yazılmayacak. İleride yalnız bağımsız kanıtları yeterli protokoller aggregator adapter’ı olarak değerlendirilebilir. |
| Musea Curator Tips | Basit ödeme, Stellar entegrasyonunu hızlıca kanıtlayabilir | Transfer bir smoke-test ve temel capability’dir; Kletia’nın farklılaştırıcı ana ürünü değildir. |
| Stellar Preflight | Alıcı hesabı, trustline, authorization ve kapasite işlemden önce kontrol edilmelidir | Genel bir preflight SDK kopyalanmayacak. Kletia route-level readiness üretir: sorunu seçilen niyet, rota ve ekonomik sonuçla bağlar ve mümkünse bir sonraki güvenli adımı gösterir. |
| SpecGuard | Doğru contract ID, değişmeyen arayüz veya WASM anlamına gelmez | Son kullanıcıya yeni bir SpecGuard ürünü sunmak yerine adapter manifesti, WASM/spec hash ve breaking-change karantinası Kletia’nın iç release kapısı olacak. |
| SprintOS AI Reviewer | AI kanıtı sınıflandırabilir; fon serbest bırakma yetkisi insan/policy katmanında kalmalıdır | Kletia’nın mevcut sınırı korunur: LLM niyeti çıkarır, deterministik compiler yürütmeyi hazırlar, cüzdan veya on-chain policy değer hareketini yetkilendirir. |

Bu karşılaştırmadan üç somut ekleme çıkar: recipient-aware delivery router, Arc Testnet–Stellar Testnet CCTP proof corridor ve adapter drift quarantine. Bunlar ayrı ürünler değil, Kletia’nın mevcut multichain intent/workflow motorunun Stellar outcome rail’ini oluşturan parçalarıdır.

### Raven kararı

Kletia’nın Raven’a runtime, planlama, quote veya execution bağımlılığı yoktur ve MVP’de de olmayacaktır. Raven, geliştiriciler için resmî doküman ve ekosistem keşfi sağlayan yararlı bir araştırma aracıdır; Kletia’nın transaction compiler’ı, protocol registry’si, ledger doğrulaması veya güven kökü değildir. Geliştirme sırasında doküman araştırmasına yardımcı olabilir, fakat bir Raven/MCP cevabı hiçbir contract ID, asset, XDR veya execution capability’sini kendiliğinden yetkilendiremez. Grant başvurusunda Raven bir Kletia bileşeni olarak sunulmayacaktır.

## G, M ve C hesapları nedir?

### G hesabı

`G...` ile başlayan adres klasik Stellar hesabıdır. Bakiye, sequence number, signer ve trustline’lar bu hesapta tutulur. İlk Kletia MVP’sinde işlemi imzalayan kaynak hesap G hesabı olacak ve Freighter üzerinden kullanıcı tarafından yönetilecek. Kletia kullanıcının secret key’ini almayacak.

### M hesabı

`M...` ile başlayan muxed account, klasik bir G hesabına 64-bit alt kimlik ekler. Borsa veya saklama servisi binlerce kullanıcı için tek Stellar hesabı kullanıyorsa, M adresi gelen ödemenin hangi kullanıcıya ait olduğunu hedef adresin içinde belirtir. Kletia’nın M desteğine ihtiyacı vardır; çünkü yalnız G adresine ödeme yapmak veya kullanıcı ID’sini yanlış memo’ya koymak fonun servis içinde yanlış hesaba yazılmasına yol açabilir. M hesabı ayrı bir ledger hesabı değildir; temel G hesabına yönlenen güvenli bir kullanıcı tanımlayıcısıdır.

Federation da bir kimlik kanıtı değildir; insan okunabilir adın o anda hangi adres/memo bilgisine çözüldüğünü verir. Kletia çözüm sonucunu manifest'e bağlar ve sonuç değişirse yeniden onay ister.

### C hesabı

`C...` ile başlayan adres Soroban contract account'tur. İmza ve yetki mantığı kodla özelleştirilebilir; passkey, çoklu imza, harcama limiti veya izinli hedef politikaları uygulanabilir. Ancak C hesabı, G hesabının her yerde kullanılabilen daha gelişmiş sürümü değildir: Classic account sequence/signer modeli, borsa memo akışları, path-payment operation'ları ve bazı anchor/cüzdan entegrasyonları G hesabı bekler. C hesabındaki token hareketleri SAC ve Soroban çağrıları üzerinden yürür. Kletia Policy Account fikri bu alana dayanır; ilk sürüm G hesabıyla çalışır, C hesabı yalnız ayrı ve capability-gated bir Testnet deneyidir.

## G/C dual rail neden gereklidir?

Kletia Stellar'ı tek bir sahte “wallet execution” türüne sıkıştırmamalıdır. İki ayrı yürütme rayı aynı intent ve receipt sözleşmesinin altında görünür biçimde seçilir:

- **G interoperability rail:** Freighter ve klasik G hesapları; SDEX/path payment, trustline, memo/muxed hedefleri, exchange/anchor uyumluluğu ve bir transaction içinde 1–100 Classic operation'ın atomik yürütülmesi. Bu ray, mevcut Stellar ekosistemiyle en geniş uyumu sağlar.
- **C policy rail:** Sınırlı bakiye taşıyan Soroban contract account; passkey veya kayıtlı signer, session/delegate, SAC transferi, Soroban protokolleri ve `__check_auth` ile on-chain kısıt. Bu ray Kletia'nın kontrollü otomasyon deneyidir, genel Stellar hesabının yerine geçmez.

Kletia route seçerken rayı, nedenini ve kaybedilen uyumlulukları kullanıcıya gösterir; G fonlarını sessizce C hesabına taşımaz. C hesapta yalnız politikanın gerektirdiği sınırlı bütçenin tutulması blast radius'i azaltır. Bir C-account işlemi ile Classic path payment aynı transaction'a paketlenemez: Classic transaction 1–100 operation'ı atomik çalıştırabilirken smart-contract transaction yalnız bir `InvokeHostFunction` operation taşır; o operation içindeki birden fazla kontrat çağrısı kendi içinde atomik olabilir. Bu nedenle Kletia Classic ve Soroban tekliflerini karşılaştırabilir, fakat yürütmede tek ray seçer. Cross-chain workflow ise hangi ray seçilirse seçilsin global atomik değildir.

## SEP nedir ve neden her SEP Kletia’ya eklenmiyor?

SEP, Stellar Ecosystem Proposal demektir. Bunlar protokolün consensus kuralları değil, cüzdanların, anchor’ların ve servislerin birbiriyle aynı dili konuşmasını sağlayan ekosistem standartlarıdır. Bir SEP numarasını desteklemek tek başına ürün değeri değildir. Kletia yalnız somut bir sorunu çözen standardı kullanmalıdır.

| Standart | Kletia’daki gerçek işi | MVP durumu |
|---|---|---|
| SEP-1 | Domain üzerinden varlık, signing key ve servis endpoint'i keşfetmek | Asset/capability kaynağı olarak çekirdek; içeriği ayrıca doğrulanır |
| SEP-10 | G/M hesabıyla web veya anchor servisinde challenge tabanlı oturum açmak | Canlı servis oturumu gerektirirse sonraki dilim; Freighter ve transaction imzası için şart değil |
| SEP-2 | `kullanici*domain.com` biçimindeki federation adresini gerçek hesaba çözmek | Ödeme/recipient interoperability dilimi; aggregator çekirdeği değil |
| SEP-23 | Muxed account biçimini standart yorumlamak | Ödeme/recipient interoperability dilimi |
| SEP-29 | Bir alıcının memo isteyip istemediğini işlemden önce kontrol etmek | Memo kullanan ödeme akışında zorunlu kapı; çekirdek swap MVP'si değil |
| SEP-41 | Soroban token arayüzü için ortak metotlar | SAC doğrulamasına yardımcı; tek başına güven kanıtı değil ve Draft |
| SEP-45 | C hesabının web veya anchor servisinde standart oturum açması | Draft; on-chain passkey işlemi için zorunlu değil, yalnız sonraki C-account session yolu |
| SEP-6/24/31 | Anchor üzerinden deposit, withdrawal veya cross-border payment | İlk aggregator kanıtından sonra |
| SEP-38 | Anchor RFQ teklifi | Draft; ilk MVP’ye dahil değil |

Bu sıralama “daha fazla SEP daha iyi ürün” düşüncesini bilinçli olarak reddeder. İlk sürümde her standart, ya kimlik sahteciliğini, ya yanlış varlık seçimini, ya kayıp fon riskini ya da eski entegrasyon bilgisini önlemelidir.

## Varlık motoru nasıl değişecek?

EVM’de token çoğunlukla `chainId + contract address` ile tanımlanır. Stellar’da native XLM dışında klasik varlık kimliği `asset code + issuer` birleşimidir. Örneğin yalnız `USDC` yazmak yeterli değildir; hangi issuer’ın USDC’si olduğu doğrulanmalıdır.

Kletia’nın planlanan `StellarAssetRef` nesnesi en az şu alanları taşır:

- Ağ ve network passphrase.
- Native XLM veya code + issuer kimliği.
- Varsa Stellar Asset Contract ID’si.
- Home domain ve keşif kaynağı.
- Trustline durumu ve limiti.
- Issuer’ın authorization, revocable ve clawback yetkileri.
- Gözlem ledger’ı ve kanıt zamanı.
- Yedi ondalıklı atomik miktar.

SAC, Stellar Asset Contract demektir. Klasik bir Stellar varlığını Soroban kontratlarının kullanabileceği token arayüzüne taşır. Contract ID’nin var olması tek başına yeterli değildir; sözleşmenin gerçekten ledger tarafından `CONTRACT_EXECUTABLE_STELLAR_ASSET` türünde oluşturulduğu ve beklenen klasik varlığı temsil ettiği doğrulanmalıdır. Bu kontrol, kötü niyetli bir kontratın kendisini resmî USDC gibi göstermesini önler.

Trustline, kullanıcının belirli bir issued asset’i tutmayı kabul ettiği ledger kaydıdır. Alıcıda gerekli trustline yoksa klasik issued asset transferi başarısız olabilir. Kletia bunu işlemden önce göstermeli; kendiliğinden trustline açmamalı, çünkü bu hesap reserve’ünü ve kullanıcı riskini etkiler.

## Stellar aggregator nasıl çalışacak?

Aggregator, protokol listesini UI’da göstermek değildir. Aynı kullanıcı niyeti için karşılaştırılabilir canlı teklifler üretmek ve bunları aynı kurallarla ölçmektir.

İlk quote kaynağı, bugün Stellar'ın yerel orderbook ve liquidity pool yollarını sunan Horizon path endpoint'leridir. İkinci kaynak Aquarius'ın Soroban AMM rotasıdır. Kletia her iki kaynağa aynı kesin asset kimliği, aynı miktar yönü, aynı recipient etkisi ve uyumlu expiry ile sorar. Bu iki teklif farklı execution rail'lerinde olduğu için “tek transaction'da birleştirilmez”; normalize edilip karşılaştırılır ve kullanıcı birini seçer.

Horizon kalıcı mimari bağımlılık yapılmamalıdır. Stellar'ın resmî veri yönlendirmesi Horizon'ı EOL sürecinde, Stellar RPC ve Portfolio API'lerini ise yeni uygulamalar için ileri yön olarak tanımlar. Horizon'ın tüm endpoint'lerinin RPC'de birebir karşılığı yoktur; path quote, account detail, trustline, operation/effect geçmişi farklı okuma stratejileri ister. Bu nedenle domain modeli provider response'larını doğrudan taşımak yerine şu portları kullanır:

- `LedgerStateReader`: güncel ledger entry, account, trustline ve contract state için öncelikle Stellar RPC.
- `PathQuoteProvider`: Classic path quote için geçici Horizon adapter'ı; daha sonra indexer veya eşdeğer kaynakla değiştirilebilir.
- `TransactionEvidenceProvider`: RPC transaction/event verisi ve gerektiğinde kalıcı indexer üzerinden receipt kanıtı.
- `PortfolioProvider`: normalize bakiye/pozisyon görünümü; Portfolio API veya indexer'a geçirilebilir.

Horizon'a özgü HAL linkleri, effect şekilleri veya response alanları bu portların dışına çıkmaz. Horizon quote servisi kullanılamıyorsa yalnız Classic quote capability'si fail-closed kapanır; Stellar profili, RPC state okuması veya doğrulanmış başka bir ray sahte sonuç üretmeden çalışmaya devam edebilir. RPC'nin sınırlı yakın geçmişi uzun vadeli receipt arşivi yerine kullanılmaz.

`StellarQuoteSetV1` şu davranışı uygular:

1. Kullanıcının niyetini strict-send veya strict-receive olarak belirler.
2. Asset code ve issuer’ları kesin olarak çözer.
3. Horizon ve Aquarius’tan canlı teklif ister.
4. Teklifleri aynı atomik hassasiyet, ücret ve min/max çıktı modeline normalize eder.
5. Provider'ın yürütme verisini, ara varlıkları, SAC'leri ve pool/contract hedeflerini decode eder.
6. Süresi geçmiş, farklı asset’e yönelen veya doğrulanamayan teklifi eler.
7. En az iki karşılaştırılabilir teklif varsa net sonuç ve risk kapılarına göre sıralar.
8. Tek geçerli teklif varsa bunu “mevcut tek teklif” diye gösterir; “en iyi rota” demez.

Strict-send, “tam 10 XLM harca, en az belirtilen USDC’yi al” anlamına gelir. Strict-receive, “alıcı tam 20 USDC alsın, bunun için en fazla belirtilen XLM’yi harca” anlamına gelir. Kletia için strict-receive özellikle önemlidir; doğal dildeki sonuç odaklı ödeme niyetini doğrudan protokol kısıtına dönüştürür.

Klasik path payment bir Soroban çağrısı değildir. Hesap, sequence, trustline, reserve, memo, path, fee ve transaction precondition'ları ledger okumalarıyla preflight edilir; tek Classic transaction içindeki operation'lar birlikte başarılı olur veya birlikte geri alınır. Aquarius gibi Soroban rotasında `simulateTransaction` ile authorization invocation tree, footprint, restore preamble ve resource fee hazırlanır. Smart-contract transaction yalnız bir `InvokeHostFunction` operation taşıyabilir; bu çağrının içindeki contract-to-contract çağrılar atomiktir. Dolayısıyla “Classic path payment + Soroban invoke tek atomik transaction” veya “her Stellar işlemi simüle edilir” ifadeleri yanlıştır.

Soroban simülasyonu imzadan önceki bir snapshot'tır, yürütme sonucu değildir. Simülasyon sonrası auth tree, ledger bounds, footprint, source account, network passphrase veya quote değişirse semantic-loss detector eski manifesti iptal eder. Özellikle root ve nested `require_auth` bağlamları karşılaştırılır; beklenen kontrat/fonksiyon çağrı ağacına yeni bir hedef eklenirse kullanıcıya yeniden sunulmadan imzalanamaz.

## Arc Testnet → Stellar Testnet CCTP proof corridor

Bu rota, ekibin beğendiği mevcut “farklı ağlar arasında işlem” yönünü Stellar’a taşıyan en somut MVP kanıtıdır. Ağustos 2026 resmî Circle tablosunda Arc Testnet CCTP domain `26`, Stellar Testnet domain `27` olarak desteklenir. Bu nedenle ilk demo yalnız uyumlu testnet ortamları arasında çalışır; Base Mainnet’ten Stellar Testnet’e veya Testnet’ten Mainnet’e rota üretilmez.

Stellar inbound CCTP, normal EVM recipient kodlamasının kopyası değildir. CCTP mesajı 32-byte payload içinde G, M ve C türünü ayırt edemediği için hem `mintRecipient` hem `destinationCaller` resmî Stellar `CctpForwarder` kontratına bağlanmalıdır. Gerçek son alıcı G/M/C strkey olarak versioned hook data içine yazılır. Circle dokümanı yanlış forwarder bağının fonları kalıcı olarak kilitleyebileceğini açıkça belirttiğinden, bu alanlar yalnız API çıktısından kopyalanmaz; resmî manifest, network passphrase ve raw message/hook decode ile yeniden doğrulanır.

G veya M alıcı resmî USDC trustline’ına sahip değilse Arc burn hazırlanmaz. Classic claimable balance bu noktada otomatik fallback değildir; `CctpForwarder` içindeki Soroban mint-and-forward çağrısı ile Classic `CreateClaimableBalance` operation’ı tek atomic ray değildir. Kullanıcı önce recipient readiness sorununu çözmeli veya açıkça başka bir hazır alıcı seçmelidir.

Kletia workflow durumu şu checkpoint’leri ayrı tutar:

`approval → burn_confirmed → awaiting_attestation → attestation_ready → mint_submitted → delivered | failed | indeterminate`

Her checkpoint source/destination domain, CCTP nonce, exact USDC miktarı, fee cap, finality eşiği, resmî forwarder, hook version ve son alıcıya bağlıdır. Circle message API’sinin Stellar adres alanlarını `null` döndürebildiği durumda Kletia raw message ve hook data’yı kendisi decode eder. CCTP message amount her iki yönde altı ondalıklı atomik birim kullanırken Stellar bakiyesi yedi ondalıklıdır; Stellar destination receipt’i message amount’un `×10` ölçeklenmiş mint ve alıcı etkisiyle uzlaşmasını zorunlu kılar.

Bu akış global atomik değildir. Arc burn işlemi tamamlandıktan sonra destination çağrısı ayrı bir işlemdir; yalnız Stellar’daki `mint_and_forward` invocation’ı mint ve final payout’u yerel olarak atomik gerçekleştirir. Attestation gecikirse durum `awaiting_attestation`, submission sonucu kaybolursa `indeterminate` kalır; sistem otomatik yeni burn, yeni imza veya aynı authorization’ı körlemesine tekrar göndermez. Başarı, yalnız source tx hash veya Circle `complete` alanıyla değil, source burn + exact nonce/attestation + destination message consumption + forward recipient balance/event kanıtı birlikte eşleşince üretilir.

Mevcut Arc Circle App Kit hedef listesine Stellar adresi eklemek doğru entegrasyon değildir. EVM destination, Stellar strkey, forwarder hook ve yedi-onluk atomik hassasiyet birbirinden farklı olduğu için ayrı `ArcToStellarCctpWorkflow` adapter’ı gerekir. Çekirdek için yeni Kletia router kontratı gerekmez; resmî CCTP kontratları ve Kletia’nın mevcut staged workflow modeli kullanılır.

## Stellar x402 ve MPP ne sağlar, ne sağlamaz?

Stellar'ın resmî agentic-payments yüzeyinde hem x402 hem MPP güncel seçeneklerdir. x402, HTTP ödeme talebini facilitator ve Stellar authorization entry akışıyla tamamlar. MPP Charge, doğrudan SAC transferine dayanan tek ödeme modelidir; MPP Session ise önceden fonlanan ve çok sayıda küçük ödeme için kullanılabilen tek yönlü kanal modelidir. Bunlar aynı protokol değildir ve Kletia'nın mevcut Base x402 yürütmesinin yerine geçmez.

Kletia'daki ortak üst seviye niyet `data_purchase` olabilir: “Bu risk raporunu satın al ama 0,05 USDC'den fazla ödeme.” Sistem servis origin'i, ağ, kesin asset, alıcı, exact price, kullanıcı tavanı ve expiry'yi gösterir; ilgili rayın gerçek settlement kanıtını `ExecutionReceiptV1` içine bağlar. Ücretli yanıt her zaman güvenilmeyen dış veri olarak kalır ve içindeki metin yeni imza, para hareketi veya sistem talimatı oluşturamaz.

x402 veya MPP desteği Kletia'yı tek başına özgün yapmaz; ikisi de resmî, başka uygulamaların da kullanabildiği payment rail'lerdir. Kletia'nın değeri ödemeyi niyet kısıtlarına, semantic-loss kontrolüne ve zincir receipt'ine bağlamasıdır. Wallet/facilitator uyumluluğu ayrıca doğrulanmalıdır; örneğin resmî x402 rehberi Freighter Mobile'ı desteklenen signer gibi varsaymaya izin vermez.

İlk dar aggregator MVP'si ödeme protokolüne bağımlı değildir. Mevcut gerçek Base x402 korunur; Stellar x402 veya MPP ancak ayrı capability flag, sürümü sabitlenmiş SDK ve Testnet settlement kanıtıyla açılır. MPP Session açık bakiye, kapanış, timeout ve replay yönetimi nedeniyle Charge'dan sonra değerlendirilir. Mock ödeme, sahte settlement veya yalnız HTTP 200'ü başarı sayma kabul edilmez.

## Intent Manifest, Semantic Invariants ve Execution Receipt nedir?

Bu üç nesne Stellar standardı değildir; Kletia'nın kendi ürün çekirdeğidir.

`IntentManifestV1`, kullanıcının gördüğü ve onayladığı planı mühürler:

- Kullanıcı hesabı ve ağ kimliği.
- Niyet ve action türü.
- Varlık, issuer veya contract kimliği.
- Alıcı ve gerekiyorsa memo/muxed ID.
- Maksimum girdi, minimum çıktı ve ücret tavanı.
- Protokol, rota ve ara varlıklar.
- Quote gözlem ledger’ı, expiry ve timebound.
- Preflight veya Soroban simülasyon özeti.

`SemanticInvariantSetV1`, manifest içinde “değişmesine izin verilmeyen” anlamı makinece karşılaştırılabilir hale getirir. Bir alanın kaldırılması kadar kapsamının genişletilmesi de ihlaldir: `USDC(code, issuer)` değerini yalnız `USDC` sembolüne düşürmek, exact recipient'i başka hesaba çevirmek, `maxInput` değerini artırmak, strict-receive yönünü değiştirmek, memo/muxed ID'yi kaybetmek veya auth invocation tree'ye yeni target eklemek planı geçersiz kılar. LLM bu kararı vermez; deterministik compiler ve ağ adapter'ı aynı invariant setini quote, XDR/auth tree ve receipt'te doğrular.

Bu manifestin amacı AI'ın anladığı metin ile cüzdanın imzaladığı işlemin farklılaşmasını engellemektir. Wallet veya ağ değişirse, quote eskirse ya da hedef çözümleme sonucu değişirse manifest geçersiz olur ve yeniden inceleme gerekir. Manifest gelecekteki sonucu garanti etmez; yalnız kullanıcının hangi sınırları onayladığını mühürler.

`ExecutionReceiptV1`, işlemden sonra gerçekten ne olduğunu kanıtlar:

- Transaction hash ve ledger.
- Beklenen ile gerçekleşen varlık hareketleri.
- İlgili Stellar operation veya Soroban event’i.
- Ödeyen, alıcı, asset ve net tutar.
- Workflow adım kimliği.
- Confirmed, failed, refunded veya indeterminate sonucu.

Receipt yalnız transaction'ın başarılı görünmesine güvenmez; beklenen balance delta ve operation/event bağını da kontrol eder. Multichain Kletia'nın özgünlüğü burada oluşur: Base'te EVM logları, Stellar'da operations/events farklıdır, fakat ikisi aynı üst düzey kanıt sözleşmesine çevrilir. Receipt ekonomik kâr, issuer solvency'si veya ücretli verinin doğruluğu iddiası değildir.

## Policy Account nedir?

Policy Account, Kletia’nın gelecekteki sınırlı otonomi katmanıdır. Kullanıcı şu tarz kuralları on-chain tanımlayabilir:

- Yalnız USDC ve XLM kullan.
- Yalnız izinli protokol ve fonksiyonları çağır.
- Tek işlemde en fazla belirli tutarı harca.
- Günlük toplam tavanı geçme.
- Yalnız izinli alıcılara ödeme yap.
- Belirli ledger veya zamandan sonra yetkiyi sonlandır.
- Büyük işlemde tekrar passkey iste.

Passkey, WebAuthn ile cihazda oluşturulan ve çoğunlukla `secp256r1` ya da P-256 eğrisini kullanan anahtardır. Face ID, Touch ID, Windows Hello veya donanım anahtarı kullanıcıya seed phrase göstermeden bir işlem niyetini imzalatabilir. Stellar Protocol 21 bu eğrinin smart contract işlemlerinde native doğrulanmasını sağladığı için Policy Account, passkey imzasını `__check_auth` içinde kontrol edebilir. OpenZeppelin’in Stellar smart-account yapısı da signer, context rule ve spending-limit/time-limit policy’lerini ayrı bileşenler olarak sunar.

Bu yapı agent'a private key veya sınırsız allowance vermeden sınırlı hareket alanı sağlayabilir. Örneğin bir context rule yalnız Aquarius router'ın belirli swap fonksiyonuna izin verir; spending policy günlük 25 USDC sınırı uygular; büyük işlem için kullanıcı passkey'i yeniden istenir. Passkey'in on-chain doğrulanması SEP-45'e ihtiyaç duymaz. SEP-45 yalnız C hesabının bir web veya anchor servisine standart biçimde login olması istendiğinde gerekir.

### Protocol 27 ve auth delegation

Stellar Mainnet, 8 Temmuz 2026'dan beri Protocol 27'yi kullanır. CAP-71 ile gelen auth delegation, custom account'ın auth kontrolünün bir bölümünü kayıtlı başka adreslere devretmesine ve aynı üst düzey signature payload/authorization context içinde nested delegate kullanmasına izin verir. Address-bound Soroban credential V2 ise imza payload'ına hesabı bağlayarak aynı anahtarın farklı hesaplarda kullanıldığı durumda cross-account replay alanını daraltır.

Bu özellik “agent'a otomatik tam yetki” değildir. Kletia Policy Account şu kapıları on-chain uygulamalıdır:

- Owner delegate, kısa ömürlü agent/session delegate ve varsa guardian önceden kayıtlı olmalıdır; kullanıcıdan gelen delegate listesi güvenilmez girdidir.
- `__check_auth`, tam invocation context içinde exact kontrat, fonksiyon, nested call, asset, destination, tutar, sayaç ve business expiry'yi doğrulamalıdır.
- `delegate_auth` yalnız kayıtlı delegate ve izinli context doğrulandıktan sonra çağrılmalıdır; boş veya yabancı delegate listesi reddedilmelidir.
- Address-bound V2 credential kullanılmalı; network passphrase, nonce ve `signatureExpirationLedger` manifest ile bağlanmalıdır.
- Delegated auth hazırlanırken recording ve enforcing aşamaları nedeniyle iki simülasyon gerekebileceği kabul edilmeli; tek simülasyon sonucu kalıcı doğruluk gibi sunulmamalıdır.

Storage TTL bir güvenlik süresi değildir. Herkes TTL'yi uzatabildiği için “ledger ömrü dolunca yetki kesin biter” denemez. Policy'nin güvenlik sonu contract state içinde ayrı bir business expiry olarak saklanıp `__check_auth` sırasında uygulanır; authorization için `signatureExpirationLedger`, transaction için time/ledger bounds ayrıca kullanılır. Temporary entry silindiğinde geri getirilemez; persistent/instance entry arşivlenebilir ve restore edilebilir. UI bu üç durumu—policy expiry, auth-signature expiry ve storage TTL/archive—birbirine karıştırmaz.

Smart Account Kit entegrasyonu bir güven kökü değildir. Ağustos 2026 itibarıyla kit pre-1.0 `0.4.x` çizgisindedir ve minor sürümlerde breaking change olabilir; dayandığı OpenZeppelin Stellar Contracts deposu da bileşenleri experimental ve “as is” olarak işaretler. Bu yüzden deneysel C rail yalnız Testnet capability flag arkasında açılır: exact SDK sürümü, account WASM hash'i, WebAuthn verifier, policy contract adresleri, network passphrase ve deployed bytecode sabitlenip doğrulanır; relayer anahtarı browser'a verilmez, backend proxy arkasında kalır. Bir bağımlılığın audit edilmiş olması Kletia policy kombinasyonunun, adapter'ının veya UI bağlarının audit edildiği anlamına gelmez.

Policy Account yine de yeni veya açıkça sabitlenmiş Soroban account/policy kontratları, sınırlı fon, recovery mekanizması, origin/challenge bağlama, counter/replay kontrolleri ve adversarial test gerektirir. Bu nedenle ilk aggregator/receipt çekirdeğinin içine sıkıştırılmaz. Ayrı Testnet demonstrator'da yalnız bir asset, bir izinli Aquarius action'ı, kesin tutar ve deadline ile kanıtlanır; production, genel otonomi veya “gasless” iddiası yapılmaz. Relayer fee'yi ödeyebilir, fakat ekonomik maliyet ortadan kalkmaz.

## MVP’de tam olarak ne yapılacak?

MVP haftalara veya SEP sayısına bölünmez; dar bir uçtan uca kabul sınırı vardır. Mevcut Base, Arc ve Arbitrum yolları korunurken Stellar için şu çekirdek birlikte çalışmalıdır:

- Birleşik arayüzde EVM tiplerinden yalıtılmış Stellar Testnet profili; RPC network-passphrase/readiness doğrulaması ve reset-aware sürümlü manifest.
- Freighter ile G hesabı bağlantısı ve kullanıcı tarafında imza; secret key'in hiçbir zaman backend'e verilmemesi.
- Native XLM ile resmî Testnet USDC için code+issuer, trustline ve doğrulanmış SAC bağını taşıyan asset graph; canlı bakiye/portföy.
- Aynı exact asset ve miktar yönüyle Horizon Classic path ve Aquarius Soroban teklifini alan, normalize eden ve tek execution rail seçen `StellarQuoteSetV1`.
- Transfer, strict-send swap ve strict-receive convert-and-pay; imzadan önce exact route, recipient, minimum/maximum, fee ve expiry incelemesi.
- Her seçilen adım için hesap türü, account existence, trustline, authorization, liabilities sonrası kapasite, reserve, memo/muxed gereksinimi ve route freshness kontrolü yapan recipient-aware safety rail; yalnız durum etiketi değil, güvenle mümkün olan bir sonraki adımı üretmesi.
- Arc Testnet domain `26` → Stellar Testnet domain `27` resmî CCTP V2 workflow’u; source burn, Iris attestation, resmî `CctpForwarder`, raw hook decode, altı/yedi ondalık uzlaşması ve destination delivery receipt’i.
- `IntentManifestV1`, `SemanticInvariantSetV1` ve ledger operation/event + balance delta'ya bağlı `ExecutionReceiptV1`.
- Aquarius ve CCTP adapter’ları için pinned network/contract/WASM/spec manifesti; drift halinde execution capability’sinin otomatik karantinaya alınması.
- RPC-first `StellarDataGateway`; Horizon'ın yalnız değiştirilebilir Classic quote adapter'ı olması ve provider kesintisinde sahte sonuç yerine capability-level fail-closed davranış.

Deneysel ve çekirdekten ayrı tek demonstrator, capability flag arkasındaki C Policy Account'tır: Testnet'te passkey owner, kayıtlı tek sınırlı delegate/session, tek izinli SAC/Aquarius action'ı, exact tutar ve business expiry. Bu demonstrator çekirdek MVP'yi bloke etmez ve production/autonomous-agent iddiası taşımaz.

Federation, SEP-10/45 servis oturumları, genel claimable-balance ürünü, anchor
işlemleri, Blend, DeFindex, Reflector, Pubnet ve dış geliştirici SDK'sı sonraki
dilimlerdir. Resmî Stellar MPP Charge sunucu adaptörü kaynakta eklenmiştir;
recipient, challenge secret ve linearizable PostgreSQL replay deposu birlikte
hazır değilse capability `unavailable` kalır. MPP Session/channel bağımsız
kontrat pin'i ve lifecycle incelemesi tamamlanmadan açılmaz. Muxed ve memo
doğrulaması seçilen recipient türü gerektiriyorsa safety rail'in parçasıdır;
bağımsız bir pazarlama özelliği değildir. Mevcut gerçek Base x402 bu daraltmadan
etkilenmez.

## Örnek kullanıcı akışları

### “10 XLM’yi en iyi canlı rotayla USDC’ye çevir”

Kletia XLM ve resmî Testnet USDC issuer’ını çözer, Horizon ve Aquarius’tan aynı strict-send koşuluyla teklif alır, geçersiz veya süresi geçmiş rotaları eler, ekonomik sonuçları normalize eder ve en az iki geçerli teklif varsa sıralar. Kullanıcı issuer, rota, minimum çıktı, toplam ücret ve expiry’yi görür. Freighter imzasından sonra ledger operation veya event’i doğrulanır ve receipt üretilir.

### “Alıcı tam 20 USDC alsın; gerekenden fazla XLM harcama”

Bu bir strict-receive niyetidir. Alıcı federation adresiyse önce çözülür; M adresi veya memo şartı korunur. Sistem 20 USDC net hedef için gereken rotaları karşılaştırır ve maksimum XLM girdisini kullanıcıya gösterir. Çözümleme sonucu veya quote değişirse eski manifest imzalanamaz.

### “Arc Testnet’teki 10 USDC’yi Stellar Testnet hesabıma taşı”

Kletia source ve destination’ın ikisinin de Testnet olduğunu doğrular; Arc CCTP domain `26`, Stellar domain `27`, resmî TokenMessenger ve `CctpForwarder` manifestlerini sabitler. Stellar G/M/C alıcısı hook data’ya yazılmadan önce recipient readiness kontrolünden geçer. Kullanıcı Arc burn işleminin miktarını, CCTP fee tavanını ve gerçek Stellar alıcısını görür ve kaynak işlemi imzalar. Sistem attestation’ı checkpoint olarak izler; destination `mint_and_forward` çağrısından sonra raw CCTP nonce, message consumption, yedi ondalıklı Stellar miktarı ve final alıcı etkisi eşleşirse receipt üretir. Kaynak burn ile hedef teslim arasındaki süre global atomiklik diye gösterilmez; kayıp response veya doğrulanamayan destination sonucu `indeterminate` kalır.

### “Bu API verisini satın al ama 0,05 USDC’den fazla ödeme”

Bu `data_purchase` niyetinin Base kolunda mevcut x402 adaptörü korunur. Stellar
kolunda resmî MPP Charge adaptörü yalnız canlı capability ve replay deposu
hazırsa gerçek payment-auth akışını açar; unsigned push kabul etmez. Kullanıcı
gerçek ödeme şartını ve üst sınırı görür; ücretli API yanıtı yalnız veri olarak
gösterilir ve yeni finansal komut gibi yürütülmez. MPP Charge kaynak entegrasyonu
tamamlanmış olsa da yapılandırılmış recipient ve fonlu settlement kanıtı henüz
release evidence değildir.

## Kod mimarisinde gerekli sınır

Stellar mevcut EVM `NetworkId` union’ına numeric chain ID verilerek eklenmemelidir. Bu, adres ve yürütme türlerinin karışmasına yol açar. Planlanan ayrım şu biçimde olmalıdır:

- `EvmNetworkRef`: Base, Arc ve Arbitrum; numeric chain ID.
- `StellarNetworkRef`: Testnet/Public Network; network passphrase, RPC kimliği ve provider capability'leri.
- `EvmAccountRef`: `0x` adresi.
- `StellarAccountRef`: source G, ayrı ledger hesabı olmayan muxed M veya deneysel policy C discriminant'ı; her operation'ın desteklediği adres türü ayrıca doğrulanır.
- `EvmAssetRef`: chain ID + contract address.
- `StellarAssetRef`: native XLM veya code + issuer + doğrulanmış SAC bağı.
- `EvmExecution`: target, calldata, value ve deadline.
- `StellarClassicExecution`: G source account, 1–100 operation içeren XDR, sequence, memo ve transaction precondition'ları.
- `StellarSorobanExecution`: tek `InvokeHostFunction` operation, nested invocation tree, auth entries, footprint, resource fee ve ledger bounds.
- `StellarDataGateway`: `LedgerStateReader`, `PathQuoteProvider`, `TransactionEvidenceProvider` ve `PortfolioProvider` portları; Horizon/RPC/Aquarius response biçimleri domain modeline sızmaz.
- `StellarProtocolManifest`: network passphrase, Protocol 27 capability'leri, provider readiness, contract ID, WASM hash, SEP-48 contract-spec hash, izinli fonksiyon/argümanlar ve Testnet reset epoch'u. Hash/spec drift’i adapter’ı execution’dan çıkarıp karantinaya alır.
- `ArcToStellarCctpWorkflow`: source/destination domain, TokenMessenger, Stellar `CctpForwarder`, hook version, raw recipient, nonce, six-decimal message amount, seven-decimal destination effect ve checkpoint evidence bağları.

Üst düzey intent, semantic invariants ve receipt ortak olabilir; imzalanabilir yürütme verisi ortaklaştırılmamalıdır. Bu ayrım Stellar varlığının yanlışlıkla EVM tokenı, Stellar hesabının EVM adresi, C policy'nin Classic operation yetkisi veya Testnet işleminin mainnet çağrısı gibi yorumlanmasını önler.

## Kontrat, API ve secret ihtiyacı

Public G-rail aggregator ve Arc→Stellar CCTP akışı için yeni custody kontratı
gerekmez. Stellar Intent Control Plane için üç ayrı Soroban kontratı ve ayrı bir
circuit-bound verifier Stellar Testnet'e deploy edilmiş, exact WASM/VK bağları
ile canlı proof ve finalize smoke testinden geçirilmiştir: intent/nullifier
lifecycle, verifier/artifact registry ve terminal receipt registry. Bunlar
kullanıcı fonu tutmaz ve kullanılan setup Testnet-development profilidir;
production trusted setup ya da Mainnet iddiası yoktur. Stellar RPC, Horizon
path adapter'ı, Aquarius Testnet API/contract manifesti, Freighter istemci
bağlantısı, Circle Iris sandbox attestation API'si, resmî Arc Testnet
TokenMessengerV2 ve resmî Stellar Testnet `CctpForwarder` gerekir. MPP Charge
recipient ve challenge secret'ı yalnız backend'de tutulur; replay deposu ortak
PostgreSQL üzerinde transactionally serialized çalışır. Kullanıcının Stellar
secret key'i backend'e veya `.env` dosyasına konmaz.

Deneysel Policy Account için yeni Kletia Soroban policy kontratı veya sürümü ve bytecode'u kesin olarak sabitlenmiş bir account/policy bileşimi Testnet'e deploy edilmelidir. Smart Account Kit relayer API key'i browser'a gömülmez. Pubnet veya gerçek değerli C-account işlemleri ancak Testnet receipt kanıtları, Protocol 27 auth-delegation testleri, policy güvenlik incelemesi ve tekrarlanabilir deployment manifesti tamamlandıktan sonra ayrı release olarak değerlendirilir.

## Kaynaklar ve durum kontrolü

- InstAward official rules ve 30 günlük scope: https://stellar.gitbook.io/scf-handbook/scf-awards/instawards/official-rules
- SCF FAQ ve anlamlı Stellar entegrasyonu: https://stellar.gitbook.io/scf-handbook/additional-support/faq
- Stellar SEP registry: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/README.md
- Network software/protocol versions: https://developers.stellar.org/docs/networks/software-versions
- Classic transaction atomicity: https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions
- Soroban transaction composition: https://developers.stellar.org/docs/learn/fundamentals/contract-development/contract-interactions/stellar-transaction
- Soroban authorization and invocation trees: https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization
- Protocol 27 auth delegation (CAP-71-01): https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071-01.md
- Protocol 27 address-bound credentials (CAP-71-02): https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071-02.md
- Auth delegation reference example: https://developers.stellar.org/docs/build/smart-contracts/example-contracts/delegate-auth
- `stellar.toml` ve SEP-1: https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep1
- Wallet authentication: https://developers.stellar.org/docs/build/apps/wallet/sep10
- Contract accounts: https://developers.stellar.org/docs/build/guides/contract-accounts
- Smart wallets and advanced policy patterns: https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets
- Smart Account Kit status: https://github.com/stellar/ecosystem-resources/blob/main/wallet-integration/smart-account-kit.md
- OpenZeppelin Stellar Contracts status: https://github.com/OpenZeppelin/stellar-contracts
- Stellar Asset Contract: https://developers.stellar.org/docs/tokens/stellar-asset-contract
- Path payments: https://developers.stellar.org/docs/build/guides/transactions/path-payments
- Trustline doğrulaması: https://developers.stellar.org/docs/build/guides/basics/verify-trustlines
- Claimable balances ve refund predicate’leri: https://developers.stellar.org/docs/build/guides/transactions/claimable-balances
- Soroban simulation: https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/simulateTransaction
- Data API direction and Horizon EOL: https://developers.stellar.org/docs/data/apis
- Horizon-to-RPC migration limits: https://developers.stellar.org/docs/data/apis/migrate-from-horizon-to-rpc
- Soroban storage lifecycle and TTL: https://developers.stellar.org/docs/build/guides/storage/storage-strategies
- Stellar x402: https://developers.stellar.org/docs/build/agentic-payments/x402
- MPP: https://developers.stellar.org/docs/build/agentic-payments/mpp
- Aquarius optimal path: https://docs.aqua.network/developers/code-examples/executing-swaps-through-optimal-path
- CCTP supported domains: https://developers.circle.com/cctp/concepts/supported-chains-and-domains
- Arc Testnet ↔ Stellar Testnet resmî CCTP quickstart: https://developers.circle.com/cctp/quickstarts/transfer-usdc-stellar-arc
- CCTP on Stellar ve forwarder güvenlik sınırı: https://developers.circle.com/cctp/references/stellar
- Stellar CCTP contracts: https://developers.circle.com/cctp/references/stellar-contracts
- Fully typed Soroban contracts ve embedded spec: https://developers.stellar.org/docs/learn/fundamentals/contract-development/types/fully-typed-contracts
- Soroban contract upgrade davranışı: https://developers.stellar.org/docs/build/guides/conventions/upgrading-contracts
- Raven’ın resmî geliştirici aracı rolü: https://developers.stellar.org/docs/build/building-with-ai
- Stellar network reset behavior: https://developers.stellar.org/docs/networks

Standardların Active, Final veya Draft durumu uygulama başlamadan ve release öncesinde resmî registry'den yeniden kontrol edilmelidir. Bu belge 21 Ağustos 2026 tarihindeki resmî durumlara göre hazırlanmıştır: Mainnet Protocol 27'dedir; Protocol 28 henüz Mainnet'te aktifmiş gibi kullanılamaz.
