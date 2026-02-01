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

// X API pause state
let xApiPaused = false;

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

// Raydium AMM Program ID - this is where pump.fun tokens graduate TO
// When a pump.fun token graduates, a new Raydium pool is created
const RAYDIUM_AMM_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

// Pump.fun migration authority PDA - confirms this is a pump.fun graduation
const PUMPFUN_MIGRATION_AUTHORITY = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';

// PumpSwap program (kept for backward compatibility in verification)
const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// Store webhook-detected graduations (in-memory, last 100)
const wsGraduations = [];
const MAX_WS_GRADUATIONS = 100;

// NOTE: WebSocket variables removed - now using webhook
// Webhook provides: time-gated, authority-verified graduations only

// Rate limiter for RPC calls (used for metadata enrichment)
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

// ===========================================
// HELIUS WEBHOOK (replaces WebSocket subscription)
// ===========================================
// WebSocket subscription is REMOVED - it was detecting ALL pump.fun activity
// Instead, use Helius Webhook configured to listen to Raydium AMM
// This gives us ONLY graduations (Raydium pool creations with pump.fun tokens)
//
// Setup in Helius Dashboard:
// 1. Go to https://dev.helius.xyz/webhooks
// 2. Create webhook: https://trakr-backend-0v6u.onrender.com/webhooks/helius
// 3. Add account: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 (Raydium AMM)
//
// The webhook endpoint is defined below in the Express routes section

// Track processed transactions to avoid duplicates
const processingTransactions = new Set();

// NOTE: extractMintFromTransaction REMOVED - webhook now provides mint directly
// No more endsWith('pump') heuristics - we trust the pump.fun authority check

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
// Legacy endpoint - now uses webhook data (same as /fast)
app.get('/api/live-launches/ws', async (req, res) => {
    try {
        const now = Date.now();
        const launches = wsGraduations.map(g => ({
            ...g,
            ageMinutes: Math.floor((now - g.detectedAt) / (1000 * 60))
        })).filter(l => l.ageMinutes < 60);
        
        res.json({
            success: true,
            source: 'helius_webhook',
            timestamp: new Date().toISOString(),
            launches: launches,
            count: launches.length,
            message: 'Real-time graduations via Helius Webhook (1-3 sec delay)'
        });
        
    } catch (error) {
        console.error('❌ WS Live Launches error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===========================================
// HELIUS WEBHOOK ENDPOINT - Receives graduations
// ===========================================
// Configure in Helius Dashboard:
// - Webhook URL: https://trakr-backend-0v6u.onrender.com/webhooks/helius
// - Transaction Type: Any
// - Account Addresses: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 (Raydium AMM)

// Track when webhook started - reject anything before this
const WEBHOOK_START_TIME = Math.floor(Date.now() / 1000);
console.log(`🕐 Webhook start time: ${WEBHOOK_START_TIME} (${new Date().toISOString()})`);

// Pump.fun migration authority PDA - MUST be present for real graduations
const PUMP_FUN_AUTHORITY_PDA = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
// RAYDIUM_AMM_PROGRAM_ID already declared at top of file

app.post('/webhooks/helius', async (req, res) => {
    res.status(200).send('OK');
    
    try {
        const payload = req.body;
        const transactions = Array.isArray(payload) ? payload : [payload];
        const now = Math.floor(Date.now() / 1000);
        
        for (const tx of transactions) {
            // TIME GATE: Reject old transactions
            if (tx.blockTime && (now - tx.blockTime) > 60) continue;
            if (tx.blockTime && tx.blockTime < WEBHOOK_START_TIME) continue;
            
            // MANDATORY: Check for pump.fun authority in signers
            const hasPumpFunAuthority = tx.signers?.includes(PUMP_FUN_AUTHORITY_PDA);
            if (!hasPumpFunAuthority) continue;
            
            // MANDATORY: Verify this is a Raydium pool initialization
            const isRaydiumInit = tx.instructions?.some(ix =>
                ix.programId === RAYDIUM_AMM_PROGRAM_ID &&
                (ix.name?.toLowerCase().includes('initialize') || 
                 ix.type?.toLowerCase().includes('init'))
            );
            if (!isRaydiumInit) continue;
            
            // ✅ THIS IS A REAL GRADUATION
            // Now find the token mint from the transaction
            let tokenMint = null;
            
            // Get from token transfers
            if (tx.tokenTransfers) {
                for (const t of tx.tokenTransfers) {
                    if (t.mint && t.mint !== 'So11111111111111111111111111111111111111112') {
                        tokenMint = t.mint;
                        break;
                    }
                }
            }
            
            // Get from token balances
            if (!tokenMint && tx.tokenBalanceChanges) {
                for (const b of tx.tokenBalanceChanges) {
                    if (b.mint && b.mint !== 'So11111111111111111111111111111111111111112') {
                        tokenMint = b.mint;
                        break;
                    }
                }
            }
            
            if (!tokenMint) {
                console.log(`⚠️ Graduation detected but no token mint found`);
                console.log(`   TX: ${tx.signature?.slice(0,16)}...`);
                continue;
            }
            
            // Skip if already cached
            if (wsGraduations.some(g => g.contract === tokenMint)) continue;
            
            const txAge = tx.blockTime ? (now - tx.blockTime) : 'unknown';
            console.log(`🎓 GRADUATION CONFIRMED: ${tokenMint.slice(0,12)}...`);
            console.log(`   TX: ${tx.signature?.slice(0,16)}... Age: ${txAge}s`);
            
            await processHeliusWebhook(tx, tokenMint);
        }
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
    }
});

// Process transaction from Helius webhook
async function processHeliusWebhook(tx, tokenMint) {
    try {
        if (!tx || !tx.signature || !tokenMint) return;
        
        // Fetch metadata with tags
        const graduationData = await getGraduationWithTags(tokenMint);
        
        const graduation = {
            symbol: graduationData.symbol || 'UNKNOWN',
            name: graduationData.name || 'Unknown Token',
            contract: tokenMint,
            ageMinutes: 0,
            liquidity: graduationData.liquidityUsd || 0,
            liquiditySol: graduationData.liquiditySol || 0,
            price: graduationData.price || 0,
            dex: 'raydium',
            hasLogo: !!graduationData.image,
            hasWebsite: !!graduationData.website,
            hasSocials: !!(graduationData.twitter || graduationData.telegram),
            website: graduationData.website || null,
            twitter: graduationData.twitter || null,
            telegram: graduationData.telegram || null,
            logo: graduationData.image || null,
            dexscreenerUrl: `https://dexscreener.com/solana/${tokenMint}`,
            jupiterUrl: `https://jup.ag/swap/SOL-${tokenMint}`,
            pumpfunUrl: `https://pump.fun/${tokenMint}`,
            graduated: true,
            graduatedAt: new Date().toISOString(),
            detectedAt: Date.now(),
            txSignature: tx.signature,
            source: 'helius_webhook',
            tags: graduationData.tags || []
        };
        
        wsGraduations.unshift(graduation);
        if (wsGraduations.length > MAX_WS_GRADUATIONS) {
            wsGraduations.pop();
        }
        
        console.log(`✅ Added: ${graduation.symbol} (${tokenMint.slice(0, 8)}...)`);
        console.log(`   🏷️ Tags: ${graduation.tags.join(', ')}`);
        console.log(`   📦 Total cached: ${wsGraduations.length}`);
        
    } catch (error) {
        console.error(`❌ Process webhook error:`, error.message);
    }
}

// Get graduation data with tags
async function getGraduationWithTags(mint) {
    const tags = ['PUMP_FUN_GRADUATED'];
    let image = null, website = null, twitter = null, telegram = null;
    let symbol = null, name = null, liquiditySol = 0, liquidityUsd = 0, price = 0;
    
    // Try Helius metadata API
    if (HELIUS_API_KEY) {
        try {
            const metaRes = await fetch(
                `https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mintAccounts: [mint] })
                }
            );
            const metaData = await metaRes.json();
            const meta = metaData?.[0];
            
            // DEBUG: Log full metadata structure
            console.log(`   📋 Helius metadata for ${mint.slice(0,8)}...:`);
            console.log(`   ${JSON.stringify(meta, null, 2).slice(0, 500)}`);
            
            if (meta) {
                symbol = meta.symbol || meta.onChainMetadata?.metadata?.symbol;
                name = meta.name || meta.onChainMetadata?.metadata?.name;
                
                // Try multiple paths for off-chain data
                const offChain = meta.offChainMetadata?.metadata || meta.offChainMetadata || {};
                
                // DEBUG: Log offchain specifically
                console.log(`   📋 OffChain: ${JSON.stringify(offChain, null, 2).slice(0, 300)}`);
                
                image = offChain.image || offChain.logo;
                website = offChain.website || offChain.external_url;
                twitter = offChain.twitter || offChain.properties?.twitter;
                telegram = offChain.telegram || offChain.properties?.telegram;
                
                // Check properties object (some tokens store socials there)
                if (offChain.properties) {
                    website = website || offChain.properties.website;
                    twitter = twitter || offChain.properties.twitter;
                    telegram = telegram || offChain.properties.telegram;
                }
            }
        } catch (e) {
            console.log(`   ⚠️ Helius metadata error: ${e.message}`);
        }
    }
    
    // Try Moralis for additional data
    try {
        const moralisData = await fetchTokenMetadata(mint);
        if (moralisData) {
            symbol = symbol || moralisData.symbol;
            name = name || moralisData.name;
            image = image || moralisData.logo;
            liquidityUsd = moralisData.liquidity || 0;
            liquiditySol = liquidityUsd / 150;
            price = moralisData.priceUsd || 0;
        }
    } catch (e) {
        console.log(`   ⚠️ Moralis error: ${e.message}`);
    }
    
    // Add tags
    if (image) tags.push('HAS_LOGO'); else tags.push('NO_LOGO');
    if (website) tags.push('HAS_WEBSITE');
    if (twitter) tags.push('HAS_TWITTER');
    if (telegram) tags.push('HAS_TELEGRAM');
    if (!(website || twitter || telegram)) tags.push('NO_SOCIALS');
    if (image && (website || twitter || telegram)) tags.push('FULL_METADATA');
    else tags.push('BARE_METADATA');
    if (liquiditySol < 5) tags.push('LOW_LIQUIDITY');
    else if (liquiditySol < 20) tags.push('MEDIUM_LIQUIDITY');
    else tags.push('HIGH_LIQUIDITY');
    
    return { mint, symbol, name, image, website, twitter, telegram, liquiditySol, liquidityUsd, price, tags };
}

// Polling endpoint for extension
app.get('/api/live-launches/fast', (req, res) => {
    const now = Date.now();
    const launches = wsGraduations.map(g => ({
        ...g,
        ageMinutes: Math.floor((now - g.detectedAt) / (1000 * 60))
    })).filter(l => l.ageMinutes < 60);
    
    res.json({
        success: true,
        source: 'helius_webhook',
        timestamp: new Date().toISOString(),
        launches,
        count: launches.length,
        message: launches.length > 0 
            ? 'Real-time graduations via Helius Webhook'
            : 'Waiting for graduations...'
    });
});

// Status endpoint
app.get('/api/live-launches/status', (req, res) => {
    res.json({
        success: true,
        webhook: {
            endpoint: '/webhooks/helius',
            cachedGraduations: wsGraduations.length,
            oldestGraduation: wsGraduations.length > 0 ? wsGraduations[wsGraduations.length - 1].graduatedAt : null,
            newestGraduation: wsGraduations.length > 0 ? wsGraduations[0].graduatedAt : null
        },
        setup: {
            step1: 'Go to https://dev.helius.xyz/webhooks',
            step2: 'Create webhook with URL: https://trakr-backend-0v6u.onrender.com/webhooks/helius',
            step3: 'Add account: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 (Raydium AMM)'
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
    // Check if paused
    if (xApiPaused) {
        console.log('⏸️ X API is paused - skipping scan');
        return { success: false, error: 'X API is paused' };
    }
    
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
                webhookActive: true // Using Helius webhook
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

// Pause X API
app.post('/api/admin/pause', (req, res) => {
    xApiPaused = true;
    console.log('⏸️ X API paused');
    res.json({ success: true, paused: true });
});

// Resume X API
app.post('/api/admin/resume', (req, res) => {
    xApiPaused = false;
    console.log('▶️ X API resumed');
    res.json({ success: true, paused: false });
});

// Get pause status
app.get('/api/admin/status', (req, res) => {
    res.json({ success: true, xApiPaused });
});

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
    console.log(`\n⚡ GRADUATION DETECTION (Helius Webhook):`);
    console.log(`   POST /webhooks/helius (Helius posts here)`);
    console.log(`   GET  /api/live-launches/fast (polling endpoint)`);
    console.log(`   GET  /api/live-launches/status (connection status)`);
    console.log(`\n✅ Webhook ready - configure Helius webhook to POST to:`);
    console.log(`   https://trakr-backend-0v6u.onrender.com/webhooks/helius`);
});
