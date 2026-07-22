// backend/src/index.ts
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { parseUserIntent, explainKletiaError } from './ai/parser.js';
import { executeKletiaEngine } from './intent/engine.js';
import premiumRoutes from './routes/premiumRoutes.js';
import { agentRoutes } from './agent/index.js';
import { validateAddress, sanitizePrompt } from './middleware/security.js';
import jwt from 'jsonwebtoken';
import alloraRoutes from './routes/allora.js';
import paymasterRoutes from './routes/paymaster.js';
import webacyRoutes from './routes/webacy.js';
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
const PORT = process.env.PORT || 3001;

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

const premiumLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 dakika
  max: 10, // IP başına 10 istek
  message: { status: 'error', message: 'You have exceeded the rate limit for premium routes.' }
});

app.use('/api/', limiter);
app.use('/api/premium', premiumLimiter, premiumRoutes);
app.use('/api/agent', validateAddress, agentRoutes);
app.use('/api/allora', alloraRoutes);
app.use('/api/paymaster', paymasterRoutes);
app.use('/api/webacy', webacyRoutes);

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

app.post('/api/onramp-token', async (req, res) => {
    try {
        const keyName = process.env.CDP_API_KEY_NAME;
        const keySecret = process.env.CDP_API_KEY_PRIVATE_KEY?.replace(/\\n/g, '\n');

        if (!keyName || !keySecret) {
            return res.status(500).json({ status: 'error', message: 'CDP API Keys are missing on the backend.' });
        }

        const requestMethod = 'POST';
        const requestPath = '/onramp/v1/token';

        const token = jwt.sign(
            {
                iss: "cdp",
                nbf: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + 120,
                sub: keyName,
                uri: `${requestMethod} api.developer.coinbase.com${requestPath}`,
            },
            keySecret,
            { algorithm: 'ES256', keyid: keyName, header: { kid: keyName, nonce: crypto.randomUUID() } }
        );

        const response = await fetch(`https://api.developer.coinbase.com${requestPath}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                destination_wallets: [
                    {
                        address: req.body.address || "0x0000000000000000000000000000000000000000",
                        blockchains: ["base"],
                    }
                ]
            })
        });

        const data = await response.json();
        
        if (!response.ok) {
            console.error("CDP Onramp Token Error:", data);
            return res.status(response.status).json({ status: 'error', message: 'Failed to generate token' });
        }

        return res.json({ status: 'success', token: data.token });
    } catch (error) {
        console.error("Error generating onramp token:", error);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});


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

const server = httpServer.listen(PORT, async () => {
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