// backend/src/ai/parser.ts
import { z } from 'zod';
import * as dotenv from 'dotenv';
import stringSimilarity from 'string-similarity';
import { TOKENS } from '../config/constants.js'; 

dotenv.config();

const SUPPORTED_TOKENS = Object.keys(TOKENS);

// ✨ KIRILMAZ ŞEMA
export const IntentSchema = z.object({
    isComplete: z.boolean().default(true),
    question: z.string().optional().default(""),
    action: z.string().default("unknown"),
    tokenIn: z.string().toUpperCase().optional(),
    tokenOut: z.string().toUpperCase().optional(),
    amount: z.string().default("0"), 
    protocol: z.string().optional(),
    durationInDays: z.coerce.number().optional().default(0)
});

export type ParsedIntent = z.infer<typeof IntentSchema>;

function predictToken(inputToken: string | undefined): string | undefined {
    if (!inputToken) return undefined;
    const cleanInput = inputToken.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (/^\d+$/.test(cleanInput)) return undefined; 
    
    const matches = stringSimilarity.findBestMatch(cleanInput, SUPPORTED_TOKENS);
    if (matches.bestMatch.rating > 0.4) return matches.bestMatch.target;
    return cleanInput;
}

export async function parseUserIntent(userPrompt: string, conversationHistory: any[] = []): Promise<ParsedIntent> {
    const apiKey = process.env.NOUS_API_KEY; 
    if (!apiKey) throw new Error("API Key eksik.");

    // ✨ YENİ NESİL PROMPT: Soru sorma zekası ve Kusursuz Token eşleşmesi bir arada!
    const systemPrompt = `Sen 20 yıllık bir Web3 Degen ve Kletia'nın Baş Mimarı olan bir Yapay Zekasın.
    Kullanıcının niyetini JSON formatında ayrıştır.
    
    KULLANILABİLİR TOKENLER: ${SUPPORTED_TOKENS.join(", ")}
    
    CRITICAL RULES (ÖLÜMCÜL KURALLAR):
    1. 🧠 SOHBET VE BİLGİ MODU: Kullanıcı sana "Nasılsın?", "Aerodrome nedir?", "Likidite nedir?" gibi genel bir sohbet veya bilgi sorusu sorarsa, SADECE {"isComplete": false, "question": "Buraya degen ağzıyla cevabını ve sohbetini yaz", "action": "chat"} döndür!
    2. 🛑 EKSİK BİLGİ SORMA (ÇOK ÖNEMLİ): Eğer kullanıcı bir işlem istiyorsa ama MİKTAR VEYA TOKEN EKSİKSE (Örn: "eth al", "usdc stake et") KESİNLİKLE "isComplete": false yap ve "question" alanında eksik bilgiyi sor! (Örn: "Ne kadar ETH almak istiyorsun patron?"). STAKING işlemiyse süreyi de sor. Kafandan miktar uydurma!
    3. ✨ MAX / TÜMÜNÜ KULLANMA İSTİSNASI: Ancak kullanıcı "usdclerimi çek", "paramın hepsiyle", "tamamını" derse, O ZAMAN soru sorma! 'amount' değerine "MAX" yaz ve isComplete: true yap.
    4. HAFIZA: Eğer kullanıcı senin sorduğun bir soruya (Örn: "Ne kadar?") sadece "0.5" diye cevap veriyorsa, önceki mesajlardaki asıl niyeti HATIRLA ve JSON'ı eksiksiz tamamla!
    5. PORTFÖY KONTROLÜ: Kullanıcı "elimde ne var", "portföyüm" derse, {"isComplete": true, "action": "portfolio"} yaz!
    6. 🎯 YÖN BELİRLEME (ÇOK ÖNEMLİ): "AL" veya "SAT" işlemlerinde elden çıkan token KESİNLİKLE 'tokenIn', alınacak token 'tokenOut' olmalıdır! Tekil işlemlerde (Lend, Stake, Withdraw) coin adını KESİNLİKLE 'tokenIn' olarak yaz!
    7. PROTOKOL KESİNLİĞİ: "Aavede", "Uniswapta" derse 'protocol' alanına yaz (Örn: "Aave").
    
    ÖRNEKLER (BUNLARI ASLA UNUTMA):
    - "0.00011 weth ile eth al" -> action: "swap", tokenIn: "WETH", tokenOut: "ETH", amount: "0.00011"
    - "0.05 usdc lend et" -> action: "lend", tokenIn: "USDC", amount: "0.05"
    - "0.1 aero stake et 4 yıl" -> action: "stake", tokenIn: "AERO", amount: "0.1", durationInDays: 1460
    - "aero usdc likidite ekle" (Miktar Yok) -> isComplete: false, question: "Ne kadar AERO ile likidite eklemek istiyorsun patron?"
    - "aavedeki usdclerimi çek" (MAX Modu) -> action: "withdraw", tokenIn: "USDC", amount: "MAX", protocol: "Aave"
    
    Sadece ve sadece geçerli bir JSON bloğu döndür.`;

    const messages = [
        { role: "system", content: systemPrompt },
        ...conversationHistory, 
        { role: "user", content: userPrompt }
    ];

    try {
        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
            method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "gemini-1.5-flash", messages: messages, temperature: 0.0 })
        });

        if (!response.ok) throw new Error("API Rejected.");
        const data = await response.json();
        const cleanContent = data.choices[0].message.content.trim().replace(/```json/gi, "").replace(/```/g, "").trim();
        
        let parsedJson;
        const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsedJson = JSON.parse(jsonMatch[0]);
        else parsedJson = JSON.parse(cleanContent);

        if (parsedJson.isComplete && parsedJson.action !== 'chat') {
            const singleAssetActions = ["withdraw", "borrow", "repay", "stake", "lend", "claim"];
            if (singleAssetActions.includes(parsedJson.action) && !parsedJson.tokenIn && parsedJson.tokenOut) {
                parsedJson.tokenIn = parsedJson.tokenOut;
                parsedJson.tokenOut = undefined;
            }

            parsedJson.tokenIn = predictToken(parsedJson.tokenIn);
            parsedJson.tokenOut = predictToken(parsedJson.tokenOut);
            
            let amtStr = String(parsedJson.amount || "0").toUpperCase();
            if (amtStr === "MAX" || amtStr.includes("TÜM") || amtStr.includes("HEPS") || amtStr.includes("ALL") || amtStr.includes("LIKIDITE")) {
                parsedJson.amount = "0"; // MAX
            } else {
                parsedJson.amount = amtStr.replace(/[^0-9.]/g, '');
                if (!parsedJson.amount) parsedJson.amount = "0";
            }
        }

        return IntentSchema.parse(parsedJson);
    } catch (error: any) {
        return {
            isComplete: false,
            question: "Sinyali tam alamadım patron. Hangi coin'i, ne kadar miktarla kullanmak istiyorsun?",
            action: "unknown", amount: "0", durationInDays: 0
        };
    }
}
