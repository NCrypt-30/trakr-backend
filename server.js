const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
require('dotenv').config();

// FIX: Ensure fetch is available (Node < 18 compatibility)
const fetch = global.fetch || require('node-fetch');
console.log('✅ Fetch available:', typeof fetch);

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// X API Configuration
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;
const TWITTER_BASE_URL = 'https://api.twitter.com/2';

// ==========================================
// HELIUS WEBSOCKET - INSTANT GRADUATIONS
// ==========================================

// Helius API Key (REQUIRED for WebSocket)
// Get your free API key at: https://dashboard.helius.dev
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// WebSocket URL for standard (free tier) Helius WebSocket
// Docs: https://www.helius.dev/docs/api-reference/rpc/websocket/logssubscribe
const HELIUS_WS_URL = HELIUS_API_KEY 
    ? `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
    : null;

// PumpSwap AMM Program ID (where Pump.fun tokens graduate to)
// Verified: https://solscan.io/account/pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// Store WebSocket-detected graduations (in-memory, last 100)
const wsGraduations = [];
const MAX_WS_GRADUATIONS = 100;

// Track WebSocket connection state
let heliusWs = null;
let wsConnected = false;
let wsReconnectAttempts = 0;
let wsConnectedAt = 0; // Track when WS connected
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 5000;
const STARTUP_GRACE_PERIOD_MS = 30000; // Ignore transactions for 30s after connecting

// Rate limiter for RPC calls (max 2 per second to avoid rate limits)
let lastRpcCallTime = 0;
const RPC_MIN_INTERVAL_MS = 500; // 500ms between RPC calls

async function rateLimitedRpcCall() {
    const now = Date.now();
    const timeSinceLastCall = now - lastRpcCallTime;
    if (timeSinceLastCall < RPC_MIN_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, RPC_MIN_INTERVAL_MS - timeSinceLastCall));
    }
    lastRpcCallTime = Date.now();
}

// Initialize Helius WebSocket connection
function initHeliusWebSocket() {
    // Check if API key is configured
    if (!HELIUS_API_KEY) {
        console.log('⚠️ HELIUS_API_KEY not set - WebSocket graduation detection disabled');
        console.log('   Get a free API key at: https://dashboard.helius.dev');
        console.log('   Using Moralis fallback only (2-minute polling)');
        return;
    }
    
    if (heliusWs && wsConnected) {
        console.log('⚡ Helius WebSocket already connected');
        return;
    }

    console.log('⚡ Connecting to Helius WebSocket...');
    console.log(`   URL: wss://mainnet.helius-rpc.com/?api-key=****`);
    console.log(`   Monitoring: ${PUMPSWAP_PROGRAM_ID}`);
    
    try {
        heliusWs = new WebSocket(HELIUS_WS_URL);
        
        heliusWs.on('open', () => {
            console.log('✅ Helius WebSocket connected!');
            wsConnected = true;
            wsConnectedAt = Date.now(); // Track connection time for grace period
            wsReconnectAttempts = 0;
            console.log(`⏳ Ignoring transactions for ${STARTUP_GRACE_PERIOD_MS/1000}s (startup grace period)...`);
            
            // Subscribe to PumpSwap program logs (graduations)
            const subscribeMsg = {
                jsonrpc: '2.0',
                id: 1,
                method: 'logsSubscribe',
                params: [
                    {
                        mentions: [PUMPSWAP_PROGRAM_ID]
                    },
                    {
                        commitment: 'confirmed'
                    }
                ]
            };
            
            heliusWs.send(JSON.stringify(subscribeMsg));
            console.log(`📡 Subscribed to PumpSwap program: ${PUMPSWAP_PROGRAM_ID}`);
        });
        
        heliusWs.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                
                // Handle subscription confirmation
                if (message.result !== undefined && message.id === 1) {
                    console.log(`✅ Subscription confirmed, ID: ${message.result}`);
                    return;
                }
                
                // Handle log notifications
                if (message.method === 'logsNotification') {
                    const logs = message.params?.result?.value?.logs || [];
                    const signature = message.params?.result?.value?.signature;
                    const err = message.params?.result?.value?.err;
                    
                    // Skip failed transactions or missing signature
                    if (err || !signature) return;
                    
                    // Check if already processing this TX (dedupe)
                    if (processingTransactions.has(signature)) return;
                    
                    // Check for "Instruction: Migrate" - the ONLY signal for graduation
                    const logsText = logs.join('\n');
                    if (!logsText.includes('Instruction: Migrate')) return;
                    
                    // Check grace period (ignore first 15s after connect)
                    const timeSinceConnect = Date.now() - wsConnectedAt;
                    if (timeSinceConnect < STARTUP_GRACE_PERIOD_MS) {
                        console.log(`⏭️ Skipping (grace period: ${Math.ceil((STARTUP_GRACE_PERIOD_MS - timeSinceConnect)/1000)}s left)`);
                        return;
                    }
                    
                    // Mark as processing
                    processingTransactions.add(signature);
                    if (processingTransactions.size > 100) {
                        const first = processingTransactions.values().next().value;
                        processingTransactions.delete(first);
                    }
                    
                    // This is a real graduation!
                    console.log(`🎓 GRADUATION: ${signature.slice(0, 20)}...`);
                    await processGraduation(signature, logs);
                }
            } catch (error) {
                // Silently ignore parse errors
            }
        });
        
        heliusWs.on('close', (code, reason) => {
            console.log(`⚠️ Helius WebSocket closed: ${code} - ${reason}`);
            wsConnected = false;
            scheduleReconnect();
        });
        
        heliusWs.on('error', (error) => {
            console.error('❌ Helius WebSocket error:', error.message);
            wsConnected = false;
        });
        
        // Keep connection alive with ping
        setInterval(() => {
            if (heliusWs && wsConnected && heliusWs.readyState === WebSocket.OPEN) {
                heliusWs.ping();
            }
        }, 30000); // Ping every 30 seconds
        
    } catch (error) {
        console.error('❌ Failed to initialize Helius WebSocket:', error.message);
        scheduleReconnect();
    }
}

// Schedule reconnection with exponential backoff
function scheduleReconnect() {
    if (wsReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('❌ Max WebSocket reconnection attempts reached. Using Moralis fallback.');
        return;
    }
    
    wsReconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * Math.pow(2, wsReconnectAttempts - 1);
    
    console.log(`🔄 Reconnecting to Helius WebSocket in ${delay / 1000}s (attempt ${wsReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    
    setTimeout(() => {
        initHeliusWebSocket();
    }, delay);
}

// Verify if a transaction is actually a create_pool (graduation)
async function verifyGraduation(signature) {
    try {
        // Use Helius RPC to fetch transaction details
        const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
        
        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getTransaction',
                params: [
                    signature,
                    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }
                ]
            })
        });
        
        if (!response.ok) return false;
        
        const data = await response.json();
        
        if (!data.result) return false;
        
        // Check instructions for create_pool
        const instructions = data.result.transaction?.message?.instructions || [];
        const innerInstructions = data.result.meta?.innerInstructions || [];
        
        // Flatten all instructions
        const allInstructions = [
            ...instructions,
            ...innerInstructions.flatMap(ii => ii.instructions || [])
        ];
        
        // Look for create_pool instruction targeting PumpSwap
        for (const ix of allInstructions) {
            const programId = ix.programId || ix.program;
            
            // Check if instruction is for PumpSwap
            if (programId === PUMPSWAP_PROGRAM_ID) {
                // If it's a parsed instruction, check the type
                if (ix.parsed?.type === 'createPool' || ix.parsed?.type === 'create_pool') {
                    return true;
                }
                
                // For unparsed instructions, check the data prefix
                // create_pool instruction typically has a specific discriminator
                if (ix.data) {
                    // The first 8 bytes of instruction data is the discriminator
                    // We'd need to know the exact discriminator for create_pool
                    // For now, accept any PumpSwap instruction that's not a swap
                    return true;
                }
            }
        }
        
        // Also check if this transaction created new accounts (typical for pool creation)
        const preTokenBalances = data.result.meta?.preTokenBalances || [];
        const postTokenBalances = data.result.meta?.postTokenBalances || [];
        
        // Pool creation typically creates new token accounts
        const newAccounts = postTokenBalances.filter(post => 
            !preTokenBalances.some(pre => pre.accountIndex === post.accountIndex)
        );
        
        // If multiple new token accounts were created, likely a pool creation
        if (newAccounts.length >= 2) {
            // Double check it involves a pump token (ends with "pump")
            const accountKeys = data.result.transaction?.message?.accountKeys || [];
            const hasPumpToken = accountKeys.some(key => {
                const pubkey = key.pubkey || key;
                return typeof pubkey === 'string' && pubkey.endsWith('pump');
            });
            
            if (hasPumpToken) {
                return true;
            }
        }
        
        return false;
        
    } catch (error) {
        console.error('Error verifying graduation:', error.message);
        // On error, assume it could be a graduation to not miss any
        return true;
    }
}

// Track transactions being processed to avoid duplicates
const processingTransactions = new Set();

// Process a detected graduation - fetch token details
async function processGraduation(signature, logs) {
    try {
        let tokenMint = null;
        const allLogs = logs.join('\n');
        
        // Try to find pump token in logs first
        const pumpMintMatch = allLogs.match(/[1-9A-HJ-NP-Za-km-z]{40,44}pump/g);
        if (pumpMintMatch && pumpMintMatch.length > 0) {
            tokenMint = pumpMintMatch[0];
            console.log(`   ✅ Found in logs: ${tokenMint.slice(0, 12)}...`);
        }
        
        // If not in logs, fetch from transaction with retry
        if (!tokenMint) {
            // Try twice with 10 second delays
            for (let attempt = 1; attempt <= 2; attempt++) {
                console.log(`   ⏳ Attempt ${attempt}: waiting 10s then fetching TX...`);
                await new Promise(r => setTimeout(r, 10000));
                tokenMint = await extractMintFromTransaction(signature);
                
                if (tokenMint) {
                    console.log(`   ✅ Found in TX: ${tokenMint.slice(0, 12)}...`);
                    break;
                }
            }
        }
        
        if (!tokenMint) {
            console.log(`   ❌ Failed to extract token after 2 attempts`);
            return;
        }
        
        // Check if we already have this token
        if (wsGraduations.some(g => g.contract === tokenMint)) {
            console.log(`   ⏭️ Already cached`);
            return;
        }
        
        // Fetch metadata
        console.log(`   📊 Fetching metadata...`);
        const metadata = await fetchTokenMetadata(tokenMint);
        
        const graduation = {
            symbol: metadata?.symbol || 'UNKNOWN',
            name: metadata?.name || 'Unknown Token',
            contract: tokenMint,
            ageMinutes: 0, // Just graduated!
            liquidity: metadata?.liquidity || 0,
            price: metadata?.priceUsd || 0,
            dex: 'pumpswap',
            hasLogo: !!metadata?.logo,
            hasWebsite: !!metadata?.website,
            hasSocials: !!(metadata?.twitter || metadata?.telegram),
            website: metadata?.website || null,
            twitter: metadata?.twitter || null,
            telegram: metadata?.telegram || null,
            logo: metadata?.logo || null,
            dexscreenerUrl: `https://dexscreener.com/solana/${tokenMint}`,
            jupiterUrl: `https://jup.ag/?sell=So11111111111111111111111111111111111111112&buy=${tokenMint}`,
            pumpfunUrl: `https://pump.fun/${tokenMint}`,
            priceChange: { m5: 0, h1: 0 },
            graduated: true,
            graduatedAt: new Date().toISOString(),
            detectedAt: Date.now(),
            txSignature: signature,
            source: 'helius_ws' // Mark as WebSocket-detected
        };
        
        // Add to beginning of array (newest first)
        wsGraduations.unshift(graduation);
        
        // Keep only last 100
        if (wsGraduations.length > MAX_WS_GRADUATIONS) {
            wsGraduations.pop();
        }
        
        console.log(`✅ Added graduation: ${graduation.symbol} (${tokenMint.slice(0, 8)}...)`);
        console.log(`   📊 Logo: ${graduation.hasLogo}, Website: ${graduation.hasWebsite}, Socials: ${graduation.hasSocials}`);
        console.log(`   💰 Price: $${graduation.price}, Liquidity: $${graduation.liquidity}`);
        console.log(`   📦 Total WS graduations cached: ${wsGraduations.length}`);
        
    } catch (error) {
        console.error('❌ Error processing graduation:', error.message);
    }
}

// Extract token mint from transaction details
async function extractMintFromTransaction(signature) {
    try {
        // Rate limit RPC calls to avoid hitting limits
        await rateLimitedRpcCall();
        
        console.log(`   📡 Fetching transaction: ${signature.slice(0, 20)}...`);
        
        const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getTransaction',
                params: [
                    signature,
                    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }
                ]
            })
        });
        
        if (!response.ok) {
            console.log(`   ❌ RPC error: ${response.status}`);
            return null;
        }
        
        const data = await response.json();
        
        if (data.error) {
            console.log(`   ❌ RPC returned error: ${data.error.message}`);
            return null;
        }
        
        if (!data.result) {
            console.log(`   ❌ No transaction result (may still be processing)`);
            return null;
        }
        
        // Method 1: Look through account keys for pump.fun token mints
        const accountKeys = data.result.transaction?.message?.accountKeys || [];
        console.log(`   🔍 Checking ${accountKeys.length} account keys...`);
        
        for (const account of accountKeys) {
            const pubkey = account.pubkey || account;
            if (typeof pubkey === 'string' && pubkey.endsWith('pump')) {
                console.log(`   ✅ Found pump token in accountKeys: ${pubkey.slice(0, 12)}...`);
                return pubkey;
            }
        }
        
        // Method 2: Check post token balances
        const postTokenBalances = data.result.meta?.postTokenBalances || [];
        console.log(`   🔍 Checking ${postTokenBalances.length} postTokenBalances...`);
        
        for (const balance of postTokenBalances) {
            if (balance.mint && balance.mint.endsWith('pump')) {
                console.log(`   ✅ Found pump token in postTokenBalances: ${balance.mint.slice(0, 12)}...`);
                return balance.mint;
            }
        }
        
        // Method 3: Check pre token balances
        const preTokenBalances = data.result.meta?.preTokenBalances || [];
        for (const balance of preTokenBalances) {
            if (balance.mint && balance.mint.endsWith('pump')) {
                console.log(`   ✅ Found pump token in preTokenBalances: ${balance.mint.slice(0, 12)}...`);
                return balance.mint;
            }
        }
        
        // Method 4: Check inner instructions for token mints
        const innerInstructions = data.result.meta?.innerInstructions || [];
        for (const inner of innerInstructions) {
            for (const ix of inner.instructions || []) {
                // Check parsed instruction info
                if (ix.parsed?.info?.mint && ix.parsed.info.mint.endsWith('pump')) {
                    console.log(`   ✅ Found pump token in innerInstruction: ${ix.parsed.info.mint.slice(0, 12)}...`);
                    return ix.parsed.info.mint;
                }
            }
        }
        
        // Method 5: Scan all account keys for ANY pump-ending address
        const allAddresses = JSON.stringify(data.result);
        const pumpMatches = allAddresses.match(/[1-9A-HJ-NP-Za-km-z]{40,44}pump/g);
        if (pumpMatches && pumpMatches.length > 0) {
            // Filter out duplicates and return first valid one
            const uniqueMints = [...new Set(pumpMatches)];
            console.log(`   ✅ Found pump token via regex scan: ${uniqueMints[0].slice(0, 12)}...`);
            return uniqueMints[0];
        }
        
        console.log(`   ❌ No pump token found in transaction`);
        return null;
    } catch (error) {
        console.error(`   ❌ Error fetching transaction: ${error.message}`);
        return null;
    }
}

// Fetch token metadata from Moralis (for enrichment)
async function fetchTokenMetadata(tokenMint) {
    try {
        const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
        
        if (!MORALIS_API_KEY) {
            console.log('⚠️ No Moralis API key for metadata enrichment');
            return null;
        }
        
        // Fetch token metadata
        const response = await fetch(
            `https://solana-gateway.moralis.io/token/mainnet/${tokenMint}/metadata`,
            {
                headers: {
                    'Accept': 'application/json',
                    'X-API-Key': MORALIS_API_KEY
                }
            }
        );
        
        if (!response.ok) {
            // Try DexScreener as fallback
            return await fetchDexScreenerMetadata(tokenMint);
        }
        
        const data = await response.json();
        
        return {
            symbol: data.symbol,
            name: data.name,
            logo: data.logo || data.image_uri || data.logoURI,
            website: data.website,
            twitter: data.twitter,
            telegram: data.telegram,
            priceUsd: data.priceUsd || 0,
            liquidity: data.liquidity || 0
        };
        
    } catch (error) {
        console.error('Error fetching Moralis metadata:', error.message);
        // Try DexScreener as fallback
        return await fetchDexScreenerMetadata(tokenMint);
    }
}

// Fallback: Fetch metadata from DexScreener
async function fetchDexScreenerMetadata(tokenMint) {
    try {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
        
        if (!response.ok) return null;
        
        const data = await response.json();
        const pair = data.pairs?.[0];
        
        if (!pair) return null;
        
        return {
            symbol: pair.baseToken?.symbol,
            name: pair.baseToken?.name,
            logo: pair.info?.imageUrl,
            website: pair.info?.websites?.[0]?.url,
            twitter: pair.info?.socials?.find(s => s.type === 'twitter')?.url,
            telegram: pair.info?.socials?.find(s => s.type === 'telegram')?.url,
            priceUsd: parseFloat(pair.priceUsd) || 0,
            liquidity: pair.liquidity?.usd || 0
        };
        
    } catch (error) {
        console.error('Error fetching DexScreener metadata:', error.message);
        return null;
    }
}

// ==========================================
// LIVE LAUNCHES ENDPOINTS
// ==========================================

// NEW: WebSocket-detected graduations (FAST - 1-3 seconds)
app.get('/api/live-launches/ws', async (req, res) => {
    try {
        // Calculate age in minutes for each graduation
        const now = Date.now();
        const launches = wsGraduations.map(g => ({
            ...g,
            ageMinutes: Math.floor((now - g.detectedAt) / (1000 * 60))
        }));
        
        res.json({
            success: true,
            source: 'helius_websocket',
            wsConnected: wsConnected,
            timestamp: new Date().toISOString(),
            launches: launches,
            count: launches.length,
            message: wsConnected 
                ? 'Real-time graduations via Helius WebSocket (1-3 sec delay)'
                : 'WebSocket disconnected - data may be stale'
        });
        
    } catch (error) {
        console.error('❌ WS Live Launches error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// NEW: Combined endpoint - tries WS first, falls back to Moralis
app.get('/api/live-launches/fast', async (req, res) => {
    try {
        const now = Date.now();
        
        // Get WebSocket graduations (fast, real-time) - NO MORALIS FALLBACK
        const wsLaunches = wsGraduations.map(g => ({
            ...g,
            ageMinutes: Math.floor((now - g.detectedAt) / (1000 * 60))
        })).filter(l => l.ageMinutes < 60); // Last hour only
        
        // Always return WebSocket data (even if empty, even if disconnected)
        return res.json({
            success: true,
            source: 'helius_websocket',
            timestamp: new Date().toISOString(),
            launches: wsLaunches,
            count: wsLaunches.length,
            wsConnected: wsConnected,
            message: !wsConnected 
                ? 'WebSocket disconnected - reconnecting...'
                : wsLaunches.length > 0 
                    ? 'Real-time graduations via Helius WebSocket'
                    : 'WebSocket connected, waiting for graduations...'
        });
        
    } catch (error) {
        console.error('❌ Fast Live Launches error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// WebSocket status endpoint
app.get('/api/live-launches/status', (req, res) => {
    res.json({
        success: true,
        websocket: {
            connected: wsConnected,
            reconnectAttempts: wsReconnectAttempts,
            cachedGraduations: wsGraduations.length,
            oldestGraduation: wsGraduations.length > 0 
                ? wsGraduations[wsGraduations.length - 1].graduatedAt 
                : null,
            newestGraduation: wsGraduations.length > 0 
                ? wsGraduations[0].graduatedAt 
                : null
        },
        endpoints: {
            fast: '/api/live-launches/fast (recommended - auto fallback)',
            websocket: '/api/live-launches/ws (WebSocket only)',
            moralis: '/api/live-launches (Moralis only - original)'
        }
    });
});


// ==========================================
// SCANNER FUNCTIONS (EXISTING)
// ==========================================

// 3-Tier Search System - X API v2 compatible (spaces instead of AND)
const SEARCH_TIERS = {
    tier1: {
        query: '(testnet OR deployed OR "smart contract deployed" OR "mainnet live" OR "devnet live" OR "no token" OR "pre-token") (DeFi OR rollup OR DEX OR DePIN OR RWA) -is:retweet',
        frequency: 5,  // minutes
        label: 'TIER 1',
        ageLimit: 365  // days - builders often have older accounts
    },
    tier2: {
        query: '(stealth OR testnet) ("launch" OR "live" OR deploy OR deployed) (DeFi OR rollup OR DePIN OR RWA) -is:retweet',
        frequency: 30,  // minutes (changed from 15 to reduce cost)
        label: 'TIER 2',
        ageLimit: 180  // days
    },
    tier3: {
        query: '("launching" OR "now live" OR "going live" OR announced OR airdrop OR presale OR "TGE coming") (DeFi OR DEX OR NFT OR DePIN OR RWA OR "AI agent") -is:retweet',
        frequency: 30,  // minutes
        label: 'TIER 3',
        ageLimit: 90  // days
    }
};

// Fetch project account details
async function fetchProjectDetails(username) {
    try {
        const response = await fetch(
            `${TWITTER_BASE_URL}/users/by/username/${username}?user.fields=created_at,public_metrics,description,verified`,
            {
                headers: {
                    'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}`
                }
            }
        );
        
        if (!response.ok) return null;
        const data = await response.json();
        return data.data;
    } catch (error) {
        console.error(`Error fetching @${username}:`, error.message);
        return null;
    }
}

// Extract project handle from tweet
function extractProjectHandle(text) {
    const mentions = text.match(/@\w+/g);
    if (!mentions || mentions.length === 0) return null;
    
    // Return first mention (usually the project)
    return mentions[0].replace('@', '');
}

// Calculate credibility score (0-100)
function calculateScore(user) {
    if (!user) return 0;
    
    let score = 0;
    const metrics = user.public_metrics;
    
    // Followers (0-30 points)
    if (metrics.followers_count >= 10000) score += 30;
    else if (metrics.followers_count >= 5000) score += 25;
    else if (metrics.followers_count >= 1000) score += 20;
    else if (metrics.followers_count >= 500) score += 15;
    else if (metrics.followers_count >= 100) score += 10;
    else score += 5;
    
    // Following ratio (0-15 points)
    const ratio = metrics.followers_count / (metrics.following_count || 1);
    if (ratio >= 2) score += 15;
    else if (ratio >= 1) score += 10;
    else if (ratio >= 0.5) score += 5;
    
    // Tweet count (0-15 points)
    if (metrics.tweet_count >= 500) score += 15;
    else if (metrics.tweet_count >= 100) score += 10;
    else if (metrics.tweet_count >= 50) score += 5;
    
    // Account age (0-20 points) - NEW: longer = better
    const createdAt = new Date(user.created_at);
    const ageInDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
    if (ageInDays >= 365) score += 20;       // 1+ year = trustworthy
    else if (ageInDays >= 180) score += 15;  // 6+ months
    else if (ageInDays >= 90) score += 10;   // 3+ months
    else if (ageInDays >= 30) score += 5;    // 1+ month
    // < 30 days = no points (suspicious)
    
    // Verified badge (0-10 points)
    if (user.verified) score += 10;
    
    // Bio check (0-10 points)
    if (user.description && user.description.length > 50) score += 10;
    else if (user.description && user.description.length > 20) score += 5;
    
    return Math.min(100, score);
}

// Detect blockchain from text
function detectBlockchain(text) {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('solana') || lowerText.includes('$sol')) return 'Solana';
    if (lowerText.includes('ethereum') || lowerText.includes('$eth') || lowerText.includes('erc20')) return 'Ethereum';
    if (lowerText.includes('base')) return 'Base';
    if (lowerText.includes('arbitrum') || lowerText.includes('$arb')) return 'Arbitrum';
    if (lowerText.includes('polygon') || lowerText.includes('$matic')) return 'Polygon';
    if (lowerText.includes('optimism') || lowerText.includes('$op')) return 'Optimism';
    if (lowerText.includes('avalanche') || lowerText.includes('$avax')) return 'Avalanche';
    if (lowerText.includes('bnb') || lowerText.includes('bsc')) return 'BSC';
    return 'Unknown';
}

// Detect project stage
function detectStage(text) {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('mainnet') || lowerText.includes('live now') || lowerText.includes('launched')) return 'MAINNET';
    if (lowerText.includes('testnet') || lowerText.includes('beta')) return 'TESTNET';
    if (lowerText.includes('stealth') || lowerText.includes('building')) return 'STEALTH';
    if (lowerText.includes('airdrop')) return 'AIRDROP';
    if (lowerText.includes('presale') || lowerText.includes('private sale')) return 'PRESALE';
    return 'PRE-LAUNCH';
}

// Scan Twitter for pre-TGE projects
async function scanTwitter(tier = 'tier2') {
    if (!TWITTER_BEARER_TOKEN) {
        console.error('❌ TWITTER_BEARER_TOKEN not set');
        return { success: false, error: 'Twitter API not configured' };
    }
    
    const tierConfig = SEARCH_TIERS[tier];
    if (!tierConfig) {
        return { success: false, error: `Invalid tier: ${tier}` };
    }
    
    console.log(`\n🔍 Scanning ${tierConfig.label}...`);
    
    try {
        const response = await fetch(
            `${TWITTER_BASE_URL}/tweets/search/recent?query=${encodeURIComponent(tierConfig.query)}&max_results=20&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username,public_metrics,created_at,description,verified`,
            {
                headers: {
                    'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}`
                }
            }
        );
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Twitter API error: ${response.status} - ${errorText}`);
            return { success: false, error: `API error: ${response.status}` };
        }
        
        const data = await response.json();
        const tweets = data.data || [];
        const users = data.includes?.users || [];
        
        console.log(`📊 Found ${tweets.length} tweets`);
        
        // Map users by ID for easy lookup
        const userMap = {};
        users.forEach(user => {
            userMap[user.id] = user;
        });
        
        // Process each tweet
        const projects = [];
        
        for (const tweet of tweets) {
            const user = userMap[tweet.author_id];
            if (!user) continue;
            
            // Check account age
            const createdAt = new Date(user.created_at);
            const ageInDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
            
            // Calculate score
            const score = calculateScore(user);
            
            // Only include if meets criteria
            if (score >= 20) {  // Minimum score threshold
                const project = {
                    id: `twitter_${user.username}_${Date.now()}`,
                    handle: user.username,
                    name: user.username,
                    description: user.description || '',
                    followers: user.public_metrics.followers_count,
                    following: user.public_metrics.following_count,
                    tweets: user.public_metrics.tweet_count,
                    accountAge: Math.floor(ageInDays),
                    score: score,
                    tier: tierConfig.label,
                    blockchain: detectBlockchain(tweet.text + ' ' + (user.description || '')),
                    stage: detectStage(tweet.text + ' ' + (user.description || '')),
                    verified: user.verified || false,
                    tweetText: tweet.text,
                    tweetId: tweet.id,
                    foundAt: new Date().toISOString(),
                    profileUrl: `https://twitter.com/${user.username}`
                };
                
                projects.push(project);
            }
        }
        
        console.log(`✅ ${projects.length} projects passed filters`);
        
        return {
            success: true,
            tier: tierConfig.label,
            projects: projects,
            totalScanned: tweets.length,
            timestamp: new Date().toISOString()
        };
        
    } catch (error) {
        console.error('Scan error:', error);
        return { success: false, error: error.message };
    }
}

// Save projects to Supabase
async function saveProjects(projects) {
    if (!projects || projects.length === 0) return;
    
    try {
        // Upsert to handle duplicates
        const { error } = await supabase
            .from('projects')
            .upsert(projects, {
                onConflict: 'handle',
                ignoreDuplicates: false
            });
            
        if (error) {
            console.error('Supabase save error:', error);
        } else {
            console.log(`💾 Saved ${projects.length} projects to database`);
        }
    } catch (error) {
        console.error('Save error:', error);
    }
}

// ==========================================
// API ENDPOINTS
// ==========================================

// Get latest projects
app.get('/api/projects', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('projects')
            .select('*')
            .order('foundAt', { ascending: false })
            .limit(50);
            
        if (error) throw error;
        
        res.json({
            success: true,
            count: data.length,
            projects: data
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Trigger manual scan
app.get('/api/scan', async (req, res) => {
    const tier = req.query.tier || 'tier2';
    
    const result = await scanTwitter(tier);
    
    if (result.success && result.projects.length > 0) {
        await saveProjects(result.projects);
    }
    
    res.json(result);
});

// ==========================================
// WHALE TRACKER ENDPOINTS
// ==========================================

// Search whale follows (rate limited: 10 searches per wallet per day)
app.post('/api/whale/search', async (req, res) => {
    try {
        const { walletAddress, username, limit = 50 } = req.body;
        
        if (!walletAddress || !username) {
            return res.status(400).json({
                success: false,
                error: 'walletAddress and username required'
            });
        }
        
        // Check rate limit (10 searches per day per wallet)
        const today = new Date().toISOString().split('T')[0];
        
        const { data: existingSearches } = await supabase
            .from('whale_searches')
            .select('search_count')
            .eq('wallet_address', walletAddress)
            .eq('search_date', today)
            .single();
            
        const currentCount = existingSearches?.search_count || 0;
        
        if (currentCount >= 10) {
            return res.json({
                success: false,
                error: 'Daily search limit reached (10/day)',
                searchesRemaining: 0
            });
        }
        
        // Perform the search
        console.log(`🐋 Searching follows for @${username}...`);
        
        // Get user ID first
        const userResponse = await fetch(
            `${TWITTER_BASE_URL}/users/by/username/${username}`,
            {
                headers: { 'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}` }
            }
        );
        
        if (!userResponse.ok) {
            return res.json({
                success: false,
                error: `User @${username} not found`
            });
        }
        
        const userData = await userResponse.json();
        const userId = userData.data?.id;
        
        if (!userId) {
            return res.json({
                success: false,
                error: `Could not find user ID for @${username}`
            });
        }
        
        // Get their following list
        const followingResponse = await fetch(
            `${TWITTER_BASE_URL}/users/${userId}/following?max_results=${Math.min(limit, 100)}&user.fields=created_at,description,public_metrics,verified`,
            {
                headers: { 'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}` }
            }
        );
        
        if (!followingResponse.ok) {
            const errorText = await followingResponse.text();
            return res.json({
                success: false,
                error: `Failed to fetch following: ${followingResponse.status}`
            });
        }
        
        const followingData = await followingResponse.json();
        const accounts = followingData.data || [];
        
        // Filter for crypto projects
        const cryptoKeywords = ['defi', 'crypto', 'web3', 'blockchain', 'nft', 'token', '$', 'dao', 'protocol', 'swap', 'dex', 'yield', 'stake', 'mint'];
        
        const cryptoProjects = accounts.filter(account => {
            const bio = (account.description || '').toLowerCase();
            return cryptoKeywords.some(kw => bio.includes(kw));
        }).map(account => ({
            username: account.username,
            name: account.name,
            description: account.description,
            followers: account.public_metrics?.followers_count || 0,
            verified: account.verified || false,
            score: calculateScore(account),
            profileUrl: `https://twitter.com/${account.username}`
        }));
        
        // Update search count
        await supabase
            .from('whale_searches')
            .upsert({
                wallet_address: walletAddress,
                search_date: today,
                search_count: currentCount + 1
            }, {
                onConflict: 'wallet_address,search_date'
            });
        
        res.json({
            success: true,
            username: username,
            totalChecked: accounts.length,
            accounts: cryptoProjects,
            searchesRemaining: 9 - currentCount
        });
        
    } catch (error) {
        console.error('Whale search error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Live whale tracking - Add whale to track
app.post('/api/whale/live/track', async (req, res) => {
    try {
        const { userWallet, whaleUsername } = req.body;
        
        if (!userWallet || !whaleUsername) {
            return res.status(400).json({
                success: false,
                error: 'userWallet and whaleUsername required'
            });
        }
        
        // Check limit (2 whales per user on free tier)
        const { data: existing } = await supabase
            .from('whale_live_tracking')
            .select('id')
            .eq('user_wallet', userWallet);
            
        if (existing && existing.length >= 2) {
            return res.json({
                success: false,
                error: 'Free tier limit: 2 tracked accounts max'
            });
        }
        
        // Verify whale exists on Twitter
        const userResponse = await fetch(
            `${TWITTER_BASE_URL}/users/by/username/${whaleUsername}`,
            {
                headers: { 'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}` }
            }
        );
        
        if (!userResponse.ok) {
            return res.json({
                success: false,
                error: `User @${whaleUsername} not found on Twitter`
            });
        }
        
        const userData = await userResponse.json();
        
        // Get their current following list (for baseline)
        const followingResponse = await fetch(
            `${TWITTER_BASE_URL}/users/${userData.data.id}/following?max_results=100`,
            {
                headers: { 'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}` }
            }
        );
        
        let currentFollowing = [];
        if (followingResponse.ok) {
            const followingData = await followingResponse.json();
            currentFollowing = (followingData.data || []).map(u => u.username);
        }
        
        // Save to database
        const { error } = await supabase
            .from('whale_live_tracking')
            .insert({
                user_wallet: userWallet,
                whale_username: whaleUsername.toLowerCase(),
                whale_user_id: userData.data.id,
                last_following: currentFollowing,
                last_checked: new Date().toISOString()
            });
            
        if (error) {
            if (error.code === '23505') { // Unique violation
                return res.json({
                    success: false,
                    error: `Already tracking @${whaleUsername}`
                });
            }
            throw error;
        }
        
        res.json({
            success: true,
            message: `Now tracking @${whaleUsername}`,
            baselineFollowing: currentFollowing.length
        });
        
    } catch (error) {
        console.error('Track whale error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Live whale tracking - Remove whale
app.post('/api/whale/live/untrack', async (req, res) => {
    try {
        const { userWallet, whaleUsername } = req.body;
        
        const { error } = await supabase
            .from('whale_live_tracking')
            .delete()
            .eq('user_wallet', userWallet)
            .eq('whale_username', whaleUsername.toLowerCase());
            
        if (error) throw error;
        
        res.json({
            success: true,
            message: `Stopped tracking @${whaleUsername}`
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Live whale tracking - Get tracking list
app.post('/api/whale/live/list', async (req, res) => {
    try {
        const { userWallet } = req.body;
        
        const { data, error } = await supabase
            .from('whale_live_tracking')
            .select('*')
            .eq('user_wallet', userWallet);
            
        if (error) throw error;
        
        res.json({
            success: true,
            data: data || [],
            limit: 2,
            current: data?.length || 0
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Live whale tracking - Get notifications
app.post('/api/whale/live/notifications', async (req, res) => {
    try {
        const { userWallet, limit = 50 } = req.body;
        
        // Get notifications for whales this user is tracking
        const { data: tracking } = await supabase
            .from('whale_live_tracking')
            .select('whale_username')
            .eq('user_wallet', userWallet);
            
        if (!tracking || tracking.length === 0) {
            return res.json({
                success: true,
                data: [],
                unreadCount: 0
            });
        }
        
        const whaleUsernames = tracking.map(t => t.whale_username);
        
        const { data: notifications, error } = await supabase
            .from('whale_live_notifications')
            .select(`
                *,
                whale_user_notifications!left(read)
            `)
            .in('whale_username', whaleUsernames)
            .order('detected_at', { ascending: false })
            .limit(limit);
            
        if (error) throw error;
        
        // Count unread
        const unreadCount = (notifications || []).filter(n => 
            !n.whale_user_notifications || 
            n.whale_user_notifications.length === 0 ||
            !n.whale_user_notifications[0].read
        ).length;
        
        res.json({
            success: true,
            data: notifications || [],
            unreadCount
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Mark notification as read
app.post('/api/whale/live/mark-read', async (req, res) => {
    try {
        const { userWallet, notificationId } = req.body;
        
        await supabase
            .from('whale_user_notifications')
            .upsert({
                user_wallet: userWallet,
                notification_id: notificationId,
                read: true
            });
            
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Mark all notifications as read
app.post('/api/whale/live/mark-all-read', async (req, res) => {
    try {
        const { userWallet } = req.body;
        
        // Get all unread notifications for this user's tracked whales
        const { data: tracking } = await supabase
            .from('whale_live_tracking')
            .select('whale_username')
            .eq('user_wallet', userWallet);
            
        if (!tracking || tracking.length === 0) {
            return res.json({ success: true });
        }
        
        const whaleUsernames = tracking.map(t => t.whale_username);
        
        const { data: notifications } = await supabase
            .from('whale_live_notifications')
            .select('id')
            .in('whale_username', whaleUsernames);
            
        if (notifications && notifications.length > 0) {
            const records = notifications.map(n => ({
                user_wallet: userWallet,
                notification_id: n.id,
                read: true
            }));
            
            await supabase
                .from('whale_user_notifications')
                .upsert(records);
        }
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Check live whales for new follows (called by cron)
async function checkLiveWhales() {
    console.log('\n🔄 Checking live whale follows...');
    
    try {
        // Get all tracked whales
        const { data: tracked } = await supabase
            .from('whale_live_tracking')
            .select('*');
            
        if (!tracked || tracked.length === 0) {
            console.log('No whales being tracked');
            return;
        }
        
        console.log(`Checking ${tracked.length} tracked whales...`);
        
        for (const whale of tracked) {
            try {
                // Get current following
                const followingResponse = await fetch(
                    `${TWITTER_BASE_URL}/users/${whale.whale_user_id}/following?max_results=100&user.fields=description,public_metrics,verified`,
                    {
                        headers: { 'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}` }
                    }
                );
                
                if (!followingResponse.ok) {
                    console.error(`Failed to fetch following for @${whale.whale_username}`);
                    continue;
                }
                
                const followingData = await followingResponse.json();
                const currentFollowing = followingData.data || [];
                const currentUsernames = currentFollowing.map(u => u.username.toLowerCase());
                
                // Compare with last known following
                const lastFollowing = (whale.last_following || []).map(u => u.toLowerCase());
                const newFollows = currentFollowing.filter(u => 
                    !lastFollowing.includes(u.username.toLowerCase())
                );
                
                if (newFollows.length > 0) {
                    console.log(`🆕 @${whale.whale_username} has ${newFollows.length} new follows!`);
                    
                    // Create notifications for new follows
                    for (const follow of newFollows) {
                        await supabase
                            .from('whale_live_notifications')
                            .insert({
                                whale_username: whale.whale_username,
                                followed_username: follow.username,
                                followed_user_data: {
                                    name: follow.name,
                                    bio: follow.description,
                                    followers: follow.public_metrics?.followers_count,
                                    verified: follow.verified
                                },
                                detected_at: new Date().toISOString()
                            });
                    }
                }
                
                // Update last following
                await supabase
                    .from('whale_live_tracking')
                    .update({
                        last_following: currentUsernames,
                        last_checked: new Date().toISOString()
                    })
                    .eq('id', whale.id);
                    
            } catch (error) {
                console.error(`Error checking @${whale.whale_username}:`, error.message);
            }
            
            // Small delay between requests
            await new Promise(r => setTimeout(r, 1000));
        }
        
        console.log('✅ Live whale check complete');
        
    } catch (error) {
        console.error('Live whale check error:', error);
    }
}

// Scheduled jobs
// Check live whales every 15 minutes
cron.schedule('*/15 * * * *', () => {
    checkLiveWhales();
});

// Run tier scans on schedule
cron.schedule('*/5 * * * *', async () => {
    const result = await scanTwitter('tier1');
    if (result.success && result.projects.length > 0) {
        await saveProjects(result.projects);
    }
});

// Tier 2 & 3 are now disabled to reduce costs
// cron.schedule('*/30 * * * *', async () => {
//     const result = await scanTwitter('tier2');
//     if (result.success && result.projects.length > 0) {
//         await saveProjects(result.projects);
//     }
// });

// Stats endpoint
app.get('/api/stats', async (req, res) => {
    try {
        const { count: projectCount } = await supabase
            .from('projects')
            .select('*', { count: 'exact', head: true });
            
        const { count: trackedWhales } = await supabase
            .from('whale_live_tracking')
            .select('*', { count: 'exact', head: true });
            
        const { count: notifications } = await supabase
            .from('whale_live_notifications')
            .select('*', { count: 'exact', head: true });
            
        res.json({
            success: true,
            stats: {
                totalProjects: projectCount || 0,
                trackedWhales: trackedWhales || 0,
                totalNotifications: notifications || 0,
                wsGraduations: wsGraduations.length,
                wsConnected: wsConnected
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==========================================
// ADMIN ENDPOINTS
// ==========================================

// Get project count
app.get('/api/admin/projects/count', async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('projects')
            .select('*', { count: 'exact', head: true });
            
        if (error) throw error;
        
        res.json({
            success: true,
            count: count || 0
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Clear all projects
app.delete('/api/admin/projects/clear-all', async (req, res) => {
    try {
        const { error } = await supabase
            .from('projects')
            .delete()
            .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all
            
        if (error) throw error;
        
        res.json({
            success: true,
            message: 'All projects cleared'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Clear old projects (older than 7 days)
app.delete('/api/admin/projects/clear-old', async (req, res) => {
    try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        
        const { error } = await supabase
            .from('projects')
            .delete()
            .lt('foundAt', sevenDaysAgo);
            
        if (error) throw error;
        
        res.json({
            success: true,
            message: 'Old projects cleared'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Filter projects by score
app.delete('/api/admin/projects/filter', async (req, res) => {
    try {
        const minScore = parseInt(req.query.minScore) || 30;
        
        const { error } = await supabase
            .from('projects')
            .delete()
            .lt('score', minScore);
            
        if (error) throw error;
        
        res.json({
            success: true,
            message: `Projects with score < ${minScore} removed`
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==========================================
// MORALIS LIVE LAUNCHES (ORIGINAL - FALLBACK)
// ==========================================

// Live Launches - Get graduated Pump.fun tokens (using Moralis API)
// Track last check time to only show NEW graduations going forward
// FIX: Start by looking back 1 hour (3600000ms) instead of starting from "now"
let lastGraduationCheck = Date.now() - (60 * 60 * 1000); // Look back 1 hour on startup

// SAFETY NET: Track seen tokens to prevent duplicates (in-memory)
const seenTokens = new Set();

// Clean up old seen tokens every hour to prevent memory bloat
setInterval(() => {
    if (seenTokens.size > 1000) {
        console.log(`🧹 Cleaning up seen tokens cache (${seenTokens.size} entries)`);
        seenTokens.clear();
    }
}, 60 * 60 * 1000); // Every hour

app.get('/api/live-launches', async (req, res) => {
    try {
        console.log('🔍 Fetching graduated Pump.fun tokens from Moralis...');
        
        const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
        
        if (!MORALIS_API_KEY) {
            console.error('❌ MORALIS_API_KEY not set in environment variables');
            return res.json({
                success: false,
                error: 'Moralis API key not configured',
                launches: [],
                totalScanned: 0,
                count: 0
            });
        }
        
        // Moralis Solana API - Get graduated tokens
        // Docs: https://docs.moralis.com/web3-data-api/solana/reference/token-api#get-graduated-tokens-by-exchange
        // Use "pumpfun" as the exchange identifier (Pump.fun tokens that completed bonding curve)
        const response = await fetch('https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/graduated', {
            headers: {
                'Accept': 'application/json',
                'X-API-Key': MORALIS_API_KEY
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Moralis API returned ${response.status}: ${errorText}`);
            return res.json({
                success: true,
                launches: [],
                totalScanned: 0,
                count: 0,
                timestamp: new Date().toISOString(),
                message: `API error: ${response.status}`,
                scamFilterRate: '0%'
            });
        }
        
        const data = await response.json();
        console.log('📦 Moralis response structure:', Object.keys(data));
        
        // Handle different possible response formats
        let tokens = [];
        if (Array.isArray(data)) {
            tokens = data;
        } else if (data.tokens && Array.isArray(data.tokens)) {
            tokens = data.tokens;
        } else if (data.result && Array.isArray(data.result)) {
            tokens = data.result;
        } else if (data.data && Array.isArray(data.data)) {
            tokens = data.data;
        }
        
        console.log(`📊 Moralis returned ${tokens.length} graduated tokens`);
        
        if (tokens.length === 0) {
            return res.json({
                success: true,
                launches: [],
                totalScanned: 0,
                count: 0,
                timestamp: new Date().toISOString(),
                message: 'No graduated tokens found',
                scamFilterRate: '0%'
            });
        }
        
        // ONLY show graduations AFTER last check (going forward only, ignore past)
        const currentCheckTime = Date.now();
        
        // Better logging to debug the filtering
        console.log(`⏰ Last check was at: ${new Date(lastGraduationCheck).toISOString()}`);
        console.log(`⏰ Current check is at: ${new Date(currentCheckTime).toISOString()}`);
        console.log(`⏰ Time window: ${Math.floor((currentCheckTime - lastGraduationCheck) / 1000 / 60)} minutes`);
        console.log(`🗂️ Currently tracking ${seenTokens.size} seen tokens`);
        
        const newGraduations = tokens.filter(token => {
            // Must have address
            const address = token.address || token.mint || token.token_address || token.tokenAddress;
            if (!address) {
                console.log('⏭️ Skipping token: no address');
                return false;
            }
            
            // DEDUPLICATION CHECK #1: Have we seen this token before?
            if (seenTokens.has(address)) {
                console.log(`⏭️ Skipping ${token.symbol || 'UNKNOWN'} (${address.slice(0, 8)}...): already seen (dedup)`);
                return false;
            }
            
            // Get graduation timestamp
            const graduatedAt = token.graduated_at || token.graduatedAt || token.migration_timestamp || token.timestamp;
            if (!graduatedAt) {
                console.log(`⏭️ Skipping ${token.symbol || 'UNKNOWN'}: no timestamp`);
                return false; // Skip if no timestamp
            }
            
            const graduatedTime = typeof graduatedAt === 'number' ? graduatedAt : new Date(graduatedAt).getTime();
            
            // Add debug logging
            const minutesAgo = Math.floor((currentCheckTime - graduatedTime) / 1000 / 60);
            const isNew = graduatedTime > lastGraduationCheck;
            
            // DEDUPLICATION CHECK #2: Time-based filter
            if (!isNew) {
                console.log(`⏭️ Skipping ${token.symbol || 'UNKNOWN'}: graduated ${minutesAgo} min ago (before last check)`);
            } else {
                console.log(`✅ Including ${token.symbol || 'UNKNOWN'}: graduated ${minutesAgo} min ago (NEW!)`);
            }
            
            // CRITICAL: Only include if graduated AFTER our last check
            if (graduatedTime <= lastGraduationCheck) {
                return false; // Skip - this graduated before we started watching
            }
            
            // Mark as seen (add to deduplication set)
            seenTokens.add(address);
            
            return true;
        });
        
        // Update last check time for next request
        lastGraduationCheck = currentCheckTime;
        
        console.log(`✅ Found ${newGraduations.length} NEW graduations since last check (filtered from ${tokens.length} total)`);
        console.log(`🗂️ Now tracking ${seenTokens.size} seen tokens`);
        
        // Format results
        const formatted = newGraduations.map(token => {
            const address = token.address || token.mint || token.token_address || token.tokenAddress;
            const graduatedAt = token.graduated_at || token.graduatedAt || token.migration_timestamp || token.timestamp;
            
            const ageMinutes = graduatedAt 
                ? Math.floor((currentCheckTime - (typeof graduatedAt === 'number' ? graduatedAt : new Date(graduatedAt).getTime())) / (1000 * 60))
                : 0;
            
            return {
                symbol: token.symbol || 'UNKNOWN',
                name: token.name || 'Unknown Token',
                contract: address,
                ageMinutes: ageMinutes,
                liquidity: token.liquidity || token.reserve_in_usd || token.raydium_liquidity || 0,
                price: token.priceUsd || token.price_usd || token.price || token.priceNative || 0,
                dex: 'raydium',
                hasLogo: !!token.logo || !!token.image_uri || !!token.logoURI,
                hasWebsite: !!token.website,
                hasSocials: !!(token.twitter || token.telegram),
                website: token.website || null,
                dexscreenerUrl: `https://dexscreener.com/solana/${address}`,
                jupiterUrl: `https://jup.ag/?sell=So11111111111111111111111111111111111111112&buy=${address}`,
                raydiumUrl: `https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${address}`,
                priceChange: {
                    m5: token.priceChange5m || token.price_change_5m || token.priceChange?.['5m'] || 0,
                    h1: token.priceChange1h || token.price_change_1h || token.priceChange?.['1h'] || 0
                },
                graduated: true,
                marketCap: token.market_cap || token.marketCap || 0,
                graduatedAt: graduatedAt, // Include timestamp
                source: 'moralis' // Mark source
            };
        });
        
        res.json({
            success: true,
            source: 'moralis',
            timestamp: new Date().toISOString(),
            totalScanned: tokens.length,
            launches: formatted,
            count: formatted.length,
            message: 'Graduated Pump.fun tokens (completed bonding curve)',
            scamFilterRate: `${tokens.length > 0 ? ((1 - formatted.length / tokens.length) * 100).toFixed(1) : '0'}%`,
            seenTokensCount: seenTokens.size // For debugging
        });
        
    } catch (error) {
        console.error('❌ Live Launches API error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==========================================
// AUTO-TRADER PRICE MONITORING
// ==========================================

// Bulk token prices endpoint - for auto-trader position monitoring
// Fetches current prices for up to 20 tokens in parallel
// Called every 1 second by extension to check positions
app.post('/api/token-prices', async (req, res) => {
    try {
        const { contracts } = req.body;
        
        // Validation
        if (!contracts || !Array.isArray(contracts) || contracts.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Array of contract addresses required',
                example: { contracts: ["ABC123...", "DEF456..."] }
            });
        }
        
        if (contracts.length > 20) {
            return res.status(400).json({
                success: false,
                error: 'Maximum 20 contracts per request'
            });
        }
        
        console.log(`💰 Fetching prices for ${contracts.length} tokens...`);
        
        // Fetch prices from DexScreener (free, fast, no auth needed)
        const prices = {};
        
        // DexScreener supports up to 30 tokens per request
        const dexScreenerUrl = `https://api.dexscreener.com/latest/dex/tokens/${contracts.join(',')}`;
        
        try {
            const response = await fetch(dexScreenerUrl);
            
            if (response.ok) {
                const data = await response.json();
                
                // Map prices by contract address
                if (data.pairs) {
                    for (const pair of data.pairs) {
                        const contract = pair.baseToken?.address;
                        if (contract && contracts.includes(contract)) {
                            // Use first pair found for each token (usually highest liquidity)
                            if (!prices[contract]) {
                                prices[contract] = {
                                    priceUsd: parseFloat(pair.priceUsd) || 0,
                                    priceNative: parseFloat(pair.priceNative) || 0,
                                    liquidity: pair.liquidity?.usd || 0,
                                    volume24h: pair.volume?.h24 || 0,
                                    priceChange: {
                                        m5: pair.priceChange?.m5 || 0,
                                        h1: pair.priceChange?.h1 || 0,
                                        h24: pair.priceChange?.h24 || 0
                                    },
                                    dex: pair.dexId,
                                    pairAddress: pair.pairAddress
                                };
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error('DexScreener fetch error:', error.message);
        }
        
        // For any missing tokens, return 0 price
        for (const contract of contracts) {
            if (!prices[contract]) {
                prices[contract] = {
                    priceUsd: 0,
                    priceNative: 0,
                    liquidity: 0,
                    volume24h: 0,
                    priceChange: { m5: 0, h1: 0, h24: 0 },
                    dex: null,
                    pairAddress: null
                };
            }
        }
        
        res.json({
            success: true,
            timestamp: Date.now(),
            prices: prices
        });
        
    } catch (error) {
        console.error('❌ Token prices error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==========================================
// JUPITER PROXY (for extension trades)
// ==========================================

// Jupiter Quote Proxy
app.get('/jupiter/quote', async (req, res) => {
    try {
        const queryString = new URLSearchParams(req.query).toString();
        const jupiterUrl = `https://quote-api.jup.ag/v6/quote?${queryString}`;
        
        console.log('🔄 Proxying Jupiter quote request...');
        
        const response = await fetch(jupiterUrl, {
            headers: { 'Accept': 'application/json' }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Jupiter quote error:', response.status, errorText);
            return res.status(response.status).json({
                error: 'Jupiter quote failed',
                status: response.status,
                message: errorText
            });
        }
        
        const data = await response.json();
        console.log('✅ Quote success');
        res.json(data);
        
    } catch (error) {
        console.error('❌ Quote proxy error:', error);
        res.status(500).json({
            error: 'Proxy error',
            message: error.message
        });
    }
});

// Jupiter Swap Proxy
app.post('/jupiter/swap', async (req, res) => {
    try {
        console.log('🔄 Proxying Jupiter swap request...');
        
        const response = await fetch('https://quote-api.jup.ag/v6/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Jupiter swap error:', response.status, errorText);
            return res.status(response.status).json({
                error: 'Jupiter swap failed',
                status: response.status,
                message: errorText
            });
        }
        
        const data = await response.json();
        console.log('✅ Swap success');
        res.json(data);
        
    } catch (error) {
        console.error('❌ Swap proxy error:', error);
        res.status(500).json({
            error: 'Proxy error',
            message: error.message
        });
    }
});

// ==========================================
// START SERVER
// ==========================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Trakr Backend running on port ${PORT}`);
    console.log(`📡 Endpoints:`);
    console.log(`   GET  /api/projects`);
    console.log(`   GET  /api/scan`);
    console.log(`   POST /api/whale/search`);
    console.log(`   POST /api/whale/live/track`);
    console.log(`   POST /api/whale/live/untrack`);
    console.log(`   POST /api/whale/live/list`);
    console.log(`   POST /api/whale/live/notifications`);
    console.log(`   POST /api/whale/live/mark-read`);
    console.log(`   POST /api/whale/live/mark-all-read`);
    console.log(`   GET  /api/stats`);
    console.log(`   GET  /api/admin/projects/count`);
    console.log(`   DELETE /api/admin/projects/clear-all`);
    console.log(`   DELETE /api/admin/projects/clear-old`);
    console.log(`   DELETE /api/admin/projects/filter`);
    console.log(`   GET  /jupiter/quote (Jupiter proxy)`);
    console.log(`   POST /jupiter/swap (Jupiter proxy)`);
    console.log(`\n⚡ NEW ENDPOINTS (Helius WebSocket):`);
    console.log(`   GET  /api/live-launches/fast (recommended - auto fallback)`);
    console.log(`   GET  /api/live-launches/ws (WebSocket only)`);
    console.log(`   GET  /api/live-launches/status (connection status)`);
    console.log(`   GET  /api/live-launches (Moralis - original)`);
    
    // Initialize Helius WebSocket after server starts
    console.log('\n⚡ Initializing Helius WebSocket for instant graduations...');
    initHeliusWebSocket();
});
