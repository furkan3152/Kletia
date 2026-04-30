// backend/src/index.ts
import express from 'express';
import cors from 'cors';
import { parseUserIntent, explainKletiaError } from './ai/parser.js';
import { executeKletiaEngine } from './intent/engine.js';

(BigInt.prototype as any).toJSON = function () {
    return this.toString();
};

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const conversationMemory: Record<string, any[]> = {};

app.post('/api/intent', async (req, res) => {
    const { prompt, userAddress } = req.body;
    
    if (!prompt || !userAddress) {
        return res.status(400).json({ status: 'error', message: 'Patron, emir veya cüzdan adresi eksik!' });
    }

    console.log(`\n📡 [YENİ EMİR]: "${prompt}" | Cüzdan: ${userAddress.substring(0,6)}...`);

    try {
        if (!conversationMemory[userAddress]) {
            conversationMemory[userAddress] = [];
        }

        const history = conversationMemory[userAddress];
        const parsedIntent = await parseUserIntent(prompt, history);

        // ✨ HAFIZA OPTİMİZASYONU: Sadece son 3 diyalogu hatırla (RAM şişmesini engeller)
        history.push({ role: 'user', content: prompt });
        history.push({ role: 'assistant', content: parsedIntent.message || 'Anlaşıldı.' });
        if (history.length > 6) conversationMemory[userAddress] = history.slice(-6);

        if (!parsedIntent.isComplete) {
            console.log(`🧠 AI Soru Soruyor/Sohbet Ediyor: ${parsedIntent.message}`);
            return res.json({ status: 'question', message: parsedIntent.message }); 
        }

        console.log(`🧠 AI Onayı Başarılı: [${parsedIntent.action.toUpperCase()}]`);
        
        conversationMemory[userAddress] = [];

        const result = await executeKletiaEngine(parsedIntent, userAddress);
        
        // ✨ TYPESCRIPT DOSTU RUH AKTARIMI
        const finalResponse = {
            message: parsedIntent.message,
            ...result
        };
        
        res.json(finalResponse); 

    } catch (error: any) {
        console.log(`❌ MOTOR HATASI YAKALANDI: ${error.message}`);
        const aiExplainedError = await explainKletiaError(prompt, error.message);
        res.json({ status: 'error', message: aiExplainedError });
    }
});

const server = app.listen(PORT as number, "0.0.0.0", () => {
    console.log(`🟢 KLETIA OMNI-ENGINE AKTİF (Port: ${PORT})`);
    console.log(`🧠 FAZ 2 YÜKLENDİ: Dinamik Hata Çevirmeni, 0x Görüşü ve Akıllı Hafıza Devrede!`);
});

server.on('error', (error: any) => {
    if (error.code === 'EADDRINUSE') console.error(`❌ KRİTİK HATA: ${PORT} portu kullanılıyor!`);
    else console.error(`❌ SUNUCU HATASI:`, error);
});

process.on('SIGINT', () => {
    console.log("\n🔴 Kletia Motoru Kapatılıyor...");
    process.exit();
});
process.on('uncaughtException', (err) => {
    console.error('Yakalanmayan Hata:', err);
});