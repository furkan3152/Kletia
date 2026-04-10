// backend/src/index.ts
import express from 'express';
import cors from 'cors';
import { parseUserIntent } from './ai/parser.js';
import { executeKletiaEngine } from './intent/engine.js';

// ✨ BIGINT KÖKTEN ÇÖZÜMÜ: Express.js (JSON.stringify) BigInt görünce çökmesin diye metne çeviriyoruz!
(BigInt.prototype as any).toJSON = function () {
    return this.toString();
};

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const conversationMemory: Record<string, any[]> = {};

app.post('/api/intent', async (req, res) => {
    const { prompt, userAddress } = req.body;
    
    if (!prompt || !userAddress) {
        return res.status(400).json({ status: 'error', message: 'Prompt ve userAddress zorunludur.' });
    }

    console.log(`\n📡 [YENİ EMİR]: "${prompt}" | Cüzdan: ${userAddress.substring(0,6)}...`);

    try {
        if (!conversationMemory[userAddress]) {
            conversationMemory[userAddress] = [];
        }

        const history = conversationMemory[userAddress];
        const parsedIntent = await parseUserIntent(prompt, history);

        if (!parsedIntent.isComplete) {
            console.log(`🧠 AI Soru Soruyor: ${parsedIntent.question}`);
            history.push({ role: 'user', content: prompt });
            history.push({ role: 'assistant', content: parsedIntent.question || '' });
            return res.json({ status: 'question', message: parsedIntent.question });
        }

        console.log(`🧠 AI Onayı Başarılı: [${parsedIntent.action.toUpperCase()}]`);
        conversationMemory[userAddress] = [];

        const result = await executeKletiaEngine(parsedIntent, userAddress);
        res.json(result); // BigInt kalkanı sayesinde artık burada ÇÖKMEYECEK!

    } catch (error: any) {
        console.log(`❌ SİSTEM HATASI: ${error.message}`);
        res.json({ status: 'error', message: error.message });
    }
});

const server = app.listen(PORT, () => {
    console.log(`🟢 KLETIA OMNI-ENGINE AKTİF (Port: ${PORT} - Stateful AI Devrede)`);
    console.log(`📡 Emirler bekleniyor...`);
});

server.on('error', (error: any) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`❌ KRİTİK HATA: ${PORT} portu kullanılıyor!`);
    } else {
        console.error(`❌ SUNUCU HATASI:`, error);
    }
});

process.on('SIGINT', () => {
    console.log("\n🔴 Kletia Motoru Kapatılıyor...");
    process.exit();
});
process.on('uncaughtException', (err) => {
    console.error('Yakalanmayan Hata:', err);
});