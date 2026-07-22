// backend/src/index.ts
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { parseUserIntent, explainKletiaError } from './ai/parser.js';
import { executeKletiaEngine } from './intent/engine.js';
import { validateAddress, sanitizePrompt } from './middleware/security.js';
import jwt from 'jsonwebtoken';
import arcRoutes from './routes/arcRoutes.js';
import { createServer } from 'http';
import { Server } from 'socket.io';

process.on('uncaughtException', (err) => {
    console.error('Yakalanmayan Hata:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Yakalanmayan Promise Reddi:', reason);
});

(BigInt.prototype as any).toJSON = function () {
    return this.toString();
};

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use(helmet());
const corsOptions = {
  origin: ['https://kletia.com', 'https://www.kletia.com', 'https://kletiaai.xyz', 'https://www.kletiaai.xyz', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization',
    'X-PAYMENT', 'PAYMENT-SIGNATURE',
    'PAYMENT-REQUIRED', 'PAYMENT-RESPONSE',
    'Access-Control-Expose-Headers'
  ],
  exposedHeaders: [
    'WWW-Authenticate',
    'PAYMENT-REQUIRED', 'PAYMENT-RESPONSE',
    'X-PAYMENT-RESPONSE'
  ]
};
app.use(cors(corsOptions));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 100, // IP başına 100 istek
  message: { status: 'error', message: 'Too many requests. Please try again later.' }
});

app.use('/api/', limiter);
app.use('/api/arc', arcRoutes);

const conversationMemory: Record<string, { history: any[], lastAccess: number }> = {};

// ✨ HAFIZA TEMİZLİK GÖREVİ: Her 30 dakikada 1 saatten eski konuşmaları siler (RAM korunması)
setInterval(() => {
  const ONE_HOUR = 60 * 60 * 1000;
  const now = Date.now();
  for (const addr in conversationMemory) {
    if (now - conversationMemory[addr].lastAccess > ONE_HOUR) {
      delete conversationMemory[addr];
    }
  }
}, 30 * 60 * 1000);



app.post('/api/intent', validateAddress, sanitizePrompt, async (req, res) => {
    const { prompt, userAddress, msgId } = req.body;
    
    if (!prompt || !userAddress) {
        return res.status(400).json({ status: 'error', message: 'Patron, emir or cüzdan adresi eksik!' });
    }

    console.log(`\n📡 [YENİ EMİR]: "${prompt}" | Cüzdan: ${userAddress.substring(0,6)}...`);

    try {
        if (!conversationMemory[userAddress]) {
            conversationMemory[userAddress] = { history: [], lastAccess: Date.now() };
        }
        conversationMemory[userAddress].lastAccess = Date.now();

        const history = conversationMemory[userAddress].history;
        const parsedIntent = await parseUserIntent(prompt, history);

        // ✨ HAFIZA OPTİMİZASYONU: Sadece son 3 diyalogu hatırla (RAM şişmesini engeller)
        history.push({ role: 'user', content: prompt });
        history.push({ role: 'assistant', content: parsedIntent.message || 'Anlaşıldı.' });
        if (history.length > 6) conversationMemory[userAddress].history = history.slice(-6);

        console.log('PARSED INTENT:', parsedIntent);
        if (!parsedIntent.isComplete) {
            console.log(`🧠 AI Soru Soruyor/Sohbet Ediyor: ${parsedIntent.message}`);
            return res.json({ status: 'question', message: parsedIntent.message }); 
        }

        console.log(`🧠 AI Onayı Başarılı: [${parsedIntent.action.toUpperCase()}]`);
        
        conversationMemory[userAddress] = { history: [], lastAccess: Date.now() };

        const result = await executeKletiaEngine(parsedIntent, userAddress, prompt, msgId);
        
        // ✨ TYPESCRIPT DOSTU RUH AKTARIMI
        const finalResponse = {
            message: result.winnerMessage || parsedIntent.message,
            ...result
        };
        
        res.json(finalResponse); 

    } catch (error: any) {
        console.log(`❌ MOTOR HATASI YAKALANDI: ${error.message}`);
        const aiExplainedError = await explainKletiaError(prompt, error.message);
        res.status(400).json({ status: 'error', message: aiExplainedError });
    }
});

const httpServer = createServer(app);
export const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  console.log(`🔌 YENİ BAĞLANTI (Socket.io): ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`🔴 BAĞLANTI KOPTU (Socket.io): ${socket.id}`);
  });
});

const server = httpServer.listen(PORT, '0.0.0.0', async () => {
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
    process.exit(1);
});