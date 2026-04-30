// backend/src/ai/parser.ts
import { z } from 'zod';
import * as dotenv from 'dotenv';
import stringSimilarity from 'string-similarity';
import { TOKENS } from '../config/constants.js'; 

dotenv.config();

const SUPPORTED_TOKENS = Object.keys(TOKENS);

// ✨ AI'IN KENDİ KENDİNE KONUŞACAĞI ESNEK ŞEMA
export const IntentSchema = z.object({
    isComplete: z.coerce.boolean().catch(true),
    question: z.string().catch(""),
    message: z.string().catch("Emir anlaşıldı patron, hemen bakıyorum."), 
    action: z.string().catch("unknown"),
    tokenIn: z.any().transform(v => v == null ? undefined : String(v).trim()).optional(),
    tokenOut: z.any().transform(v => v == null ? undefined : String(v).trim()).optional(),
    amount: z.any().transform(v => (v == null || v === "") ? "0" : String(v)), 
    protocol: z.any().transform(v => v == null ? undefined : String(v)).optional(),
    durationInDays: z.coerce.number().catch(0)
});

export type ParsedIntent = z.infer<typeof IntentSchema>;

// ✨ 0x KÖRLÜĞÜ ÇÖZÜCÜ (Evrensel Akıllı Düzeltme)
function predictToken(inputToken: string | undefined): string | undefined {
    if (!inputToken) return undefined;
    const cleanInput = inputToken.trim();
    
    // EĞER 0X İLE BAŞLIYORSA DİREKT KABUL ET (BİLİNMEYEN BİR MEMECOIN OLABİLİR)
    if (cleanInput.startsWith("0x") || cleanInput.startsWith("0X")) return cleanInput; 

    const cleanAlpha = cleanInput.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (/^\d+$/.test(cleanAlpha)) return undefined; 
    
    const matches = stringSimilarity.findBestMatch(cleanAlpha, SUPPORTED_TOKENS);
    if (matches.bestMatch.rating > 0.4) return matches.bestMatch.target;
    
    // Eşleşmese bile ne girdiyse döndür, bırak hatayı EVM (Engine) versin
    return cleanAlpha; 
}

// ✨ AI HATA ÇEVİRMENİ
export async function explainKletiaError(userPrompt: string, rawError: string): Promise<string> {
    const apiKey = process.env.NOUS_API_KEY; 
    if (!apiKey) return "Patron, ağda bir sorun var ama AI bağlantım koptuğu için detay veremiyorum.";

    const systemPrompt = `Sen 20 yıllık bir Web3 Degen'sin. Kullanıcı sana şu emri verdi: "${userPrompt}".
    Kletia motoru bu işlemi yaparken blokzincirden şu hatayı aldı: "${rawError}"
    GÖREVİN: Bu teknik hatayı kullanıcının anlayacağı kısa, net ve Degen diliyle açıkla. Asla robotik konuşma. Sadece söyleyeceğin metni döndür.`;

    try {
        const response = await fetch("https://inference-api.nousresearch.com/v1/chat/completions", {
            method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "Hermes-4-70B", messages: [{ role: "system", content: systemPrompt }], temperature: 0.3 })
        });
        const data = await response.json();
        return data.choices[0].message.content.trim();
    } catch {
        return "Patron, işlem blokzincirde patladı. RPC'yi veya cüzdan bakiyeni bir kontrol et.";
    }
}

export async function parseUserIntent(userPrompt: string, conversationHistory: any[] = []): Promise<ParsedIntent> {
    const apiKey = process.env.NOUS_API_KEY; 
    if (!apiKey) throw new Error("API Key eksik.");

    // ✨ HERMES 70B'Yİ ZAPT EDEN BAŞ MİMAR KURAL SETİ
    const systemPrompt = `Sen 20 yıllık bir Web3 Degen ve Kletia'nın Baş Mimarı olan bir Yapay Zekasın. 
    AŞAĞIDAKİ KURALLARA GÖRE KESİNLİKLE VE SADECE JSON FORMATINDA YANIT VER. JSON DIŞINDA HİÇBİR KELİME YAZMA!

    KULLANILABİLİR BİLİNEN TOKENLER: ${SUPPORTED_TOKENS.join(", ")}

    CRITICAL RULES (ÖLÜMCÜL KURALLAR):
    1. 🧠 SOHBET VE SELAMLAŞMA: Kullanıcı "merhaba", "hi kletia", "nasılsın" diyorsa SADECE "action": "chat" ve "isComplete": false döndür. Cevabı 'message'a yaz.
    2. 💼 PORTFÖY: "elimde ne var", "portföyüm", "bakiyem" gibi taleplerde KESİNLİKLE {"isComplete": true, "action": "portfolio"} döndür.
    3. 🛑 EKSİK BİLGİ: Kullanıcı swap yapmak istiyor ama tokenlerden biri eksikse {"isComplete": false, "action": "unknown"} yap ve eksiği 'message' alanında sor. 

    ✨ EYLEM EŞLEŞTİRME (ACTION MAPPING) KURALLARI:
    - Takas (Swap): "al", "sat", "çevir", "swap" -> action: "swap"
    - Likidite Ekleme: "likidite ekle", "havuza ekle", "pool yap" -> action: "add_liquidity"
    - Likidite Kaldırma: "likidite kaldır", "havuzdan çık", "likidite boz" -> action: "remove_liquidity"
    - Stake (Kilitleme): "stake et", "kilitle" -> action: "stake"
    - Borç/Kredi: "borç al", "kredi çek" -> action: "borrow" / "yatır", "borç ver" -> action: "lend"
    - Çekim: "çek", "kurtar", "withdraw" -> action: "withdraw"
    - Chat (Sohbet): "selam", "merhaba", "naber" -> action: "chat"

    ✨ HERMES AKIL KONTROLÜ (KRİTİK İSTİSNALAR):
    - STAKE VE LİKİDİTE KALDIRMA İSTİSNASI: Kullanıcı "0.1 aero stake et" veya "aero likiditesini kaldır" dediğinde hedef (tokenOut) İSTEME! 'tokenIn' olarak belirtilen tokeni al ve işlemi tamamla ("isComplete": true).
    - MİKTAR (AMOUNT) OTOMATİĞİ: Kullanıcı likidite kaldırırken veya stake ederken MİKTAR BELİRTMEMİŞSE, işlemi eksik sayma ("isComplete": false YAPMA!). 'amount' değerine otomatik olarak "MAX" yaz ve işlemi onayla ("isComplete": true).
    - TOKEN BULMA (EVRENSEL 0x): Cümle içindeki token isimlerini VEYA '0x...' ile başlayan akıllı kontrat adreslerini sırasıyla tokenIn ve tokenOut olarak zekice yerleştir. Kontrat adreslerine asla dokunma, olduğu gibi bırak!

    ÖRNEK ÇIKTILAR (BUNLARA KESİNLİKLE UY):

    Kullanıcı: "0.1 aero stake et 4 yıllığına"
    Çıktı: {"isComplete": true, "action": "stake", "tokenIn": "AERO", "amount": "0.1", "durationInDays": 1460, "message": "0.1 AERO'yu 4 yıllığına kilitliyorum patron, sabreden derviş muradına ermiş!"}

    Kullanıcı: "aero ile usdc arasındaki likiditemi kaldır"
    Çıktı: {"isComplete": true, "action": "remove_liquidity", "tokenIn": "AERO", "tokenOut": "USDC", "amount": "MAX", "message": "AERO/USDC havuzundaki tüm likiditeni bozup cüzdanına çekiyorum patron."}

    Kullanıcı: "0.05 usdc ile 0x4158734D47Fc9692176B5085E0F52ee0Da5d47F1 al"
    Çıktı: {"isComplete": true, "action": "swap", "tokenIn": "USDC", "tokenOut": "0x4158734D47Fc9692176B5085E0F52ee0Da5d47F1", "amount": "0.05", "message": "USDC ile o riskli degen kontratını alıyoruz patron, kemerleri bağla!"}

    Kullanıcı: "hi kletia"
    Çıktı: {"isComplete": false, "action": "chat", "message": "Selam Patron! Piyasada bugün neyi pumplatıyoruz?"}

    SADECE JSON DÖNDÜR. İLK KARAKTER '{', SON KARAKTER '}' OLMALIDIR.`;

    const messages = [
        { role: "system", content: systemPrompt },
        ...conversationHistory, 
        { role: "user", content: userPrompt }
    ];

    try {
        const response = await fetch("https://inference-api.nousresearch.com/v1/chat/completions", {
            method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "Hermes-4-70B", messages: messages, temperature: 0.1 })
        });

        if (!response.ok) throw new Error(`API Rejected: ${response.status}`);
        
        const data = await response.json();
        let cleanContent = data.choices[0].message.content.trim();
        
        // Çökme Koruması: AI inat edip markdown (```json) kullanırsa diye temizliyoruz
        cleanContent = cleanContent.replace(/```json/gi, "").replace(/```/g, "").trim();
        
        let parsedJson;
        try {
            const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                parsedJson = JSON.parse(jsonMatch[0]);
            } else {
                parsedJson = JSON.parse(cleanContent);
            }
        } catch (e) {
            console.error("🚨 JSON PARSE HATASI! AI Çıktısı:", cleanContent);
            throw new Error("Yapay Zeka JSON formatını bozdu, tekrar deneyin.");
        }

        // ✨ İŞLEM MANTIK VE CHAT FİLTRESİ
        if (parsedJson.action === 'chat' || parsedJson.action === 'greet') {
            return {
                isComplete: false,
                action: "chat", // Engine'in tanıması için standartlaştırıldı
                message: parsedJson.message || "Selam Patron!",
                question: "", amount: "0", durationInDays: 0
            };
        }

        if (parsedJson.isComplete) {
            const singleAssetActions = ["withdraw", "borrow", "repay", "stake", "lend", "claim"];
            
            // Eğer tek tokenli bir işlemse ve AI yanlışlıkla "tokenIn" yerine "tokenOut"a yazmışsa düzelt
            if (singleAssetActions.includes(parsedJson.action) && !parsedJson.tokenIn && parsedJson.tokenOut) {
                parsedJson.tokenIn = parsedJson.tokenOut;
                parsedJson.tokenOut = undefined;
            }

            parsedJson.tokenIn = predictToken(parsedJson.tokenIn);
            parsedJson.tokenOut = predictToken(parsedJson.tokenOut);
            
            // "MAX" ve Miktar Kontrolü
            let amtStr = String(parsedJson.amount || "0").toUpperCase();
            if (amtStr === "MAX" || amtStr.includes("TÜM") || amtStr.includes("HEPS") || amtStr.includes("ALL")) {
                parsedJson.amount = "MAX"; 
            } else {
                parsedJson.amount = amtStr.replace(/[^0-9.]/g, '');
                if (!parsedJson.amount) parsedJson.amount = "0";
            }
        }

        return IntentSchema.parse(parsedJson);
    } catch (error: any) {
        console.error("🚨 KLETIA PARSER ÇÖKTÜ DETAYI:", error.message || error);
        return {
            isComplete: false,
            message: "Patron, ağda bir sinyal kopukluğu oldu. Ne yapacağımızı tekrar söyler misin?",
            question: "Sinyali tam alamadım.", action: "unknown", amount: "0", durationInDays: 0
        };
    }
}