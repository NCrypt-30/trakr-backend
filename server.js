const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
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
// SCANNER FUNCTIONS
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

// Scan X API for projects (tiered)
async function scanProjects(tier = 'tier1') {
    const tierConfig = SEARCH_TIERS[tier];
    console.log(`🔍 Starting ${tierConfig.label} scan...`);
    
    // Track last tweet count per tier (for cooldown skip)
    if (!global.lastTweetCount) {
        global.lastTweetCount = {};
    }
    
    // Fix #3: Cooldown skip for Tier 1 if last run returned 0 tweets
    if (tier === 'tier1' && global.lastTweetCount[tier] === 0) {
        console.log('⏭️ Skipping TIER 1 — last run empty (cooldown)');
        global.lastTweetCount[tier] = undefined; // Reset so next run executes
        return [];
    }
    
    const query = tierConfig.query;
    const allProjects = [];
    
    // Track projects found in this scan cycle (across all tiers)
    if (!global.currentScanProjects) {
        global.currentScanProjects = new Set();
    }
    
    // Hard lookup caps per tier (prevents surprise bills)
    const LOOKUP_CAPS = {
        tier1: 5,
        tier2: 10,
        tier3: 10
    };
    
    // Track old accounts to never fetch again (persistent across scans)
    if (!global.oldAccounts) {
        global.oldAccounts = new Set();
    }
    
    // Track lookups performed this scan
    let lookupsPerformed = 0;
    
    // In-memory cache for mentioned projects (reduces duplicate API calls)
    const projectCache = new Map();
    
    // Cheap tweet filter (before extraction)
    function looksLikeProjectTweet(text) {
        // Must contain project-related keywords
        if (!/testnet|deployed|launch|live|airdrop|presale|mainnet|building|shipping|stealth/i.test(text)) {
            return false;
        }
        // Filter out influencer/opinion content
        if (/thread|thoughts|opinion|market update|daily|gm |gn /i.test(text)) {
            return false;
        }
        return true;
    }
    
    // Cheap handle heuristic filter
    function looksLikeProjectHandle(username) {
        if (!username || username.length < 4) return false;
        if (/\d{4,}$/.test(username)) return false; // spammy numbers
        // Allow most, filter obvious junk
        return true;
    }
    
    try {
        // Calculate time window based on tier frequency
        // Add 60-second safety buffer to ensure start_time is safely in the past
        const SAFETY_BUFFER_SECONDS = 60;
        const now = new Date();
        const windowMinutes = tierConfig.frequency;
        const windowStart = new Date(
            now.getTime() 
            - windowMinutes * 60 * 1000 
            - SAFETY_BUFFER_SECONDS * 1000
        );
        
        const params = new URLSearchParams({
            query: query,
            'max_results': '10',  // Both tiers capped at 10 for cost control
            'tweet.fields': 'created_at',
            'user.fields': 'username,description,verified,created_at,public_metrics,url',
            'expansions': 'author_id',
            'start_time': windowStart.toISOString()
        });
        
        const response = await fetch(
            `${TWITTER_BASE_URL}/tweets/search/recent?${params}`,
            {
                headers: {
                    'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}`
                }
            }
        );
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`${tierConfig.label} query failed:`, response.status);
            console.error(`${tierConfig.label} error body:`, errorText);
            return [];
        }
        
        const data = await response.json();
        
        // Track tweet count for cooldown skip logic
        const tweetCount = data.data?.length || 0;
        global.lastTweetCount[tier] = tweetCount;
        
        // DEBUG: Log query and results
        console.log(`${tierConfig.label} query:`, query.substring(0, 100) + '...');
        console.log(`${tierConfig.label} tweets returned:`, tweetCount);
        
        if (!data.data || data.data.length === 0) {
            console.log(`${tierConfig.label}: No tweets found in last ${windowMinutes} minutes`);
            return [];
        }
        
        // Build user map
        const users = {};
        if (data.includes && data.includes.users) {
            data.includes.users.forEach(user => {
                users[user.id] = user;
            });
        }
        
        // Parse tweets
        for (const tweet of data.data) {
            // Skip retweets
            if (tweet.text.startsWith('RT @')) {
                continue;
            }
            
            // CHEAP FILTER #1: Tweet content filter (FREE, eliminates 50-70% junk)
            if (!looksLikeProjectTweet(tweet.text)) {
                continue;
            }
            
            const user = users[tweet.author_id] || {};
            const projectHandle = user.username;
            
            if (!projectHandle) continue;
            
            // CROSS-TIER DEDUPLICATION: Skip if already found by higher tier this scan cycle
            if (global.currentScanProjects.has(projectHandle)) {
                console.log(`⏭️ ${tierConfig.label}: Skipping @${projectHandle} - already found by higher tier`);
                continue;
            }
            
            // CHEAP FILTER #2: Handle heuristics (FREE)
            if (!looksLikeProjectHandle(projectHandle)) {
                console.log(`⏭️ ${tierConfig.label}: Skipping @${projectHandle} - doesn't look like project handle`);
                continue;
            }
            
            // CHEAP FILTER #3: Skip known old accounts (FREE, no API call)
            if (global.oldAccounts.has(projectHandle)) {
                continue; // Silent skip - already know it's old
            }
            
            // Use author's data (already in response, no extra API call)
            const projectUser = user;
            
            // Tiered age filter - check the PROJECT's age
            const accountCreated = new Date(projectUser.created_at);
            const ageLimitDays = tierConfig.ageLimit || 90;
            const cutoffDate = new Date(Date.now() - ageLimitDays * 24 * 60 * 60 * 1000);
            
            if (accountCreated < cutoffDate) {
                // Add to permanent skip list
                global.oldAccounts.add(projectHandle);
                console.log(`⏭️ ${tierConfig.label}: Skipping @${projectHandle} - account too old (${accountCreated.toISOString().split('T')[0]})`);
                continue;
            }
            
            console.log(`✅ ${tierConfig.label}: Found @${projectHandle} (created ${accountCreated.toISOString().split('T')[0]})`);
            
            // Mark as found in this scan cycle
            global.currentScanProjects.add(projectHandle);
            
            // Store PROJECT's data
            allProjects.push({
                tweet_id: tweet.id,
                project_handle: projectHandle,
                tweet_text: tweet.text,
                tweet_author: user.username,
                tweet_url: `https://twitter.com/${user.username}/status/${tweet.id}`,
                project_url: `https://twitter.com/${projectHandle}`,
                account_created: projectUser.created_at,  // PROJECT's data
                followers: projectUser.public_metrics?.followers_count || 0,  // PROJECT's data
                verified: projectUser.verified || false,  // PROJECT's data
                bio: projectUser.description || '',  // PROJECT's data
                found_by_query: tierConfig.label  // Store tier label (TIER 1, TIER 2, TIER 3)
            });
        }
        
    } catch (error) {
        console.error(`${tierConfig.label} error:`, error.message);
        return [];
    }
    
    console.log(`📊 ${tierConfig.label}: Found ${allProjects.length} projects`);
    console.log(`📦 ${tierConfig.label}: Cache hits saved ${projectCache.size} API calls`);
    
    // Deduplicate by tweet_id
    const unique = [];
    const seenIds = new Set();
    for (const proj of allProjects) {
        if (!seenIds.has(proj.tweet_id)) {
            seenIds.add(proj.tweet_id);
            unique.push(proj);
        }
    }
    
    console.log(`✅ ${tierConfig.label}: ${unique.length} unique projects after deduplication`);
    
    // Save to database (FIX #4: Don't overwrite fetched data!)
    if (unique.length > 0) {
        const { error } = await supabase
            .from('projects')
            .upsert(unique.map(p => ({
                tweet_id: p.tweet_id,
                project_handle: p.project_handle,
                tweet_text: p.tweet_text,
                tweet_author: p.tweet_author,
                tweet_url: p.tweet_url,
                project_url: p.project_url,
                account_created: p.account_created,  // Keep real data
                followers: p.followers,  // Keep real data
                verified: p.verified,  // Keep real data
                bio: p.bio,  // Keep real data
                found_by_query: p.found_by_query,  // Tier label (TIER 1, TIER 2, TIER 3)
                found_at: new Date().toISOString()
            })), {
                onConflict: 'tweet_id'
            });
        
        if (error) {
            console.error(`❌ ${tierConfig.label} database error:`, error);
        } else {
            console.log(`💾 ${tierConfig.label}: Saved ${unique.length} projects to database`);
        }
    }
    
    return unique;
}

// ==========================================
// WHALE TRACKER FUNCTIONS
// ==========================================

// Fetch user's following list
async function fetchUserFollowing(username, limit = 10) {
    try {
        // First get user ID
        const userResponse = await fetch(
            `${TWITTER_BASE_URL}/users/by/username/${username}`,
            {
                headers: {
                    'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}`
                }
            }
        );
        
        if (!userResponse.ok) {
            throw new Error(`User ${username} not found`);
        }
        
        const userData = await userResponse.json();
        const userId = userData.data.id;
        
        // Now get following list
        const params = new URLSearchParams({
            'max_results': limit.toString(),
            'user.fields': 'username,description,created_at,public_metrics,verified,url'
        });
        
        const response = await fetch(
            `${TWITTER_BASE_URL}/users/${userId}/following?${params}`,
            {
                headers: {
                    'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}`
                }
            }
        );
        
        if (!response.ok) {
            throw new Error('Failed to fetch following list');
        }
        
        const data = await response.json();
        return data.data || [];
        
    } catch (error) {
        throw error;
    }
}

// Check rate limit for wallet
async function checkRateLimit(walletAddress) {
    const { data, error } = await supabase
        .from('whale_searches')
        .select('*')
        .eq('wallet_address', walletAddress)
        .gte('searched_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    
    if (error) {
        console.error('Rate limit check error:', error);
        return { allowed: true, remaining: 10 };
    }
    
    const searchCount = data.length;
    const remaining = Math.max(0, 10 - searchCount);
    
    return {
        allowed: searchCount < 10,
        remaining: remaining,
        count: searchCount
    };
}

// Log whale search
async function logWhaleSearch(walletAddress, username, resultsCount) {
    const { error } = await supabase
        .from('whale_searches')
        .insert({
            wallet_address: walletAddress,
            username_searched: username,
            results_count: resultsCount,
            searched_at: new Date().toISOString()
        });
    
    if (error) {
        console.error('Error logging search:', error);
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
            .order('found_at', { ascending: false })
            .limit(200); // Get more to ensure we have 100 unique after dedup
        
        if (error) throw error;
        
        // Deduplicate by project_handle (keep most recent)
        const uniqueProjects = [];
        const seenHandles = new Set();
        
        for (const project of data) {
            if (!seenHandles.has(project.project_handle)) {
                seenHandles.add(project.project_handle);
                uniqueProjects.push(project);
                
                if (uniqueProjects.length >= 100) break; // Stop at 100 unique
            }
        }
        
        console.log(`📤 Returning ${uniqueProjects.length} unique projects (from ${data.length} total tweets)`);
        
        res.json({
            success: true,
            count: uniqueProjects.length,
            projects: uniqueProjects
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==========================================
// RUGCHECK API FUNCTION
// ==========================================

// Fetch RugCheck data for a token (holder %, creator %, score)
async function fetchRugCheckData(contract) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout
        
        const response = await fetch(`https://api.rugcheck.xyz/v1/tokens/${contract}/report`, {
            signal: controller.signal
        });
        clearTimeout(timeout);
        
        if (!response.ok) {
            console.log(`⚠️ RugCheck ${response.status} for ${contract.slice(0, 8)}`);
            return null;
        }
        
        const data = await response.json();
        
        // Extract key metrics (convert score from 0-1000 to 0-100)
        return {
            score: Math.round((data.score || 0) / 10),  // Convert to 0-100 scale
            topHolders: data.topHolders || null,  // e.g. "45%"
            creator: data.creator || null,         // e.g. "15%"
            risks: data.risks || [],
            rugged: data.rugged || false
        };
    } catch (error) {
        console.log(`⚠️ RugCheck error for ${contract.slice(0, 8)}:`, error.message);
        return null;
    }
}

// Live Launches - Get graduated Pump.fun tokens (using Moralis API)
// Track last check time to only show NEW graduations going forward
// FIX: Start by looking back 1 hour (3600000ms) instead of starting from "now"
let lastGraduationCheck = Date.now() - (60 * 60 * 1000); // Look back 1 hour on startup

// ✅ REMOVED: seenTokens global dedup - let frontend handle it!
// const seenTokens = new Set();

// Clean up old seen tokens every hour to prevent memory bloat
// ✅ REMOVED: No longer needed without seenTokens
/*
setInterval(() => {
    if (seenTokens.size > 1000) {
        console.log(`🧹 Cleaning up seen tokens cache (${seenTokens.size} entries)`);
        seenTokens.clear();
    }
}, 60 * 60 * 1000); // Every hour
*/

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
        // ✅ REMOVED: console.log(`🗂️ Currently tracking ${seenTokens.size} seen tokens`);
        
        let oldCount = 0;
        let newCount = 0;
        
        const newGraduations = tokens.filter(token => {
            // Must have address
            const address = token.address || token.mint || token.token_address || token.tokenAddress;
            if (!address) {
                return false;
            }
            
            // ✅ REMOVED: DEDUPLICATION CHECK #1 - Let frontend handle it!
            // if (seenTokens.has(address)) {
            //     console.log(`⏭️ Skipping ${token.symbol}: already seen (dedup)`);
            //     return false;
            // }
            
            // Get graduation timestamp
            const graduatedAt = token.graduated_at || token.graduatedAt || token.migration_timestamp || token.timestamp;
            if (!graduatedAt) {
                return false; // Skip if no timestamp
            }
            
            const graduatedTime = typeof graduatedAt === 'number' ? graduatedAt : new Date(graduatedAt).getTime();
            
            // DEDUPLICATION CHECK #2: Time-based filter
            if (graduatedTime <= lastGraduationCheck) {
                oldCount++; // Count old tokens
                return false; // Skip - graduated before last check
            }
            
            // ✅ REMOVED: Mark as seen
            // seenTokens.add(address);
            
            newCount++; // Count new tokens
            return true;
        });
        
        // Update last check time for next request
        lastGraduationCheck = currentCheckTime;
        
        console.log(`✅ Found ${newGraduations.length} NEW graduations since last check`);
        console.log(`   Skipped ${oldCount} old graduations (before last check)`);
        // ✅ REMOVED: console.log(`🗂️ Now tracking ${seenTokens.size} seen tokens`);
        
        // Fetch RugCheck data for all tokens in parallel
        console.log(`📊 Fetching RugCheck data for ${newGraduations.length} tokens...`);
        const rugCheckPromises = newGraduations.map(async token => {
            const address = token.address || token.mint || token.token_address || token.tokenAddress;
            return {
                address,
                rugCheckData: await fetchRugCheckData(address)
            };
        });
        
        const rugCheckResults = await Promise.all(rugCheckPromises);
        const rugCheckMap = new Map(rugCheckResults.map(r => [r.address, r.rugCheckData]));
        
        // Format results with RugCheck data
        const formatted = newGraduations.map(token => {
            const address = token.address || token.mint || token.token_address || token.tokenAddress;
            const graduatedAt = token.graduated_at || token.graduatedAt || token.migration_timestamp || token.timestamp;
            const rugCheck = rugCheckMap.get(address);
            
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
                // RugCheck data
                rugCheckScore: rugCheck?.score || 0,
                topHolders: rugCheck?.topHolders || null,
                creatorHoldings: rugCheck?.creator || null,
                rugCheckRisks: rugCheck?.risks || [],
                isRugged: rugCheck?.rugged || false
            };
        });
        
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            totalScanned: tokens.length,
            launches: formatted,
            count: formatted.length,
            message: 'Graduated Pump.fun tokens (completed bonding curve)',
            scamFilterRate: `${tokens.length > 0 ? ((1 - formatted.length / tokens.length) * 100).toFixed(1) : '0'}%`
            // ✅ REMOVED: seenTokensCount: seenTokens.size
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
                error: 'Maximum 20 contracts per request',
                received: contracts.length
            });
        }
        
        console.log(`💰 Fetching prices for ${contracts.length} tokens...`);
        const startTime = Date.now();
        
        // Fetch all prices in PARALLEL for speed
        const pricePromises = contracts.map(async (contract) => {
            try {
                // DexScreener API - free, reliable, real-time
                const url = `https://api.dexscreener.com/latest/dex/tokens/${contract}`;
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout
                
                const response = await fetch(url, {
                    signal: controller.signal
                });
                clearTimeout(timeout);
                
                if (!response.ok) {
                    console.error(`DexScreener error for ${contract.slice(0, 8)}: ${response.status}`);
                    return {
                        contract: contract,
                        success: false,
                        error: `API returned ${response.status}`
                    };
                }
                
                const data = await response.json();
                
                // Check if token has trading pairs
                if (!data.pairs || data.pairs.length === 0) {
                    return {
                        contract: contract,
                        success: false,
                        error: 'No trading pairs found'
                    };
                }
                
                // Get most liquid pair (usually first)
                const pair = data.pairs[0];
                
                return {
                    contract: contract,
                    success: true,
                    price: pair.priceUsd || '0',
                    priceNative: pair.priceNative || '0',
                    priceChange: {
                        m5: parseFloat(pair.priceChange?.m5 || 0),
                        h1: parseFloat(pair.priceChange?.h1 || 0),
                        h6: parseFloat(pair.priceChange?.h6 || 0),
                        h24: parseFloat(pair.priceChange?.h24 || 0)
                    },
                    volume: {
                        m5: parseFloat(pair.volume?.m5 || 0),
                        h1: parseFloat(pair.volume?.h1 || 0),
                        h6: parseFloat(pair.volume?.h6 || 0),
                        h24: parseFloat(pair.volume?.h24 || 0)
                    },
                    liquidity: {
                        usd: parseFloat(pair.liquidity?.usd || 0),
                        base: parseFloat(pair.liquidity?.base || 0),
                        quote: parseFloat(pair.liquidity?.quote || 0)
                    },
                    pairAddress: pair.pairAddress,
                    dexId: pair.dexId,
                    url: pair.url
                };
                
            } catch (error) {
                console.error(`Error fetching ${contract.slice(0, 8)}:`, error.message);
                return {
                    contract: contract,
                    success: false,
                    error: error.message
                };
            }
        });
        
        // Wait for ALL requests to complete
        const prices = await Promise.all(pricePromises);
        
        const elapsed = Date.now() - startTime;
        const successCount = prices.filter(p => p.success).length;
        const failedCount = prices.length - successCount;
        
        console.log(`✅ Fetched ${successCount}/${contracts.length} prices in ${elapsed}ms (${failedCount} failed)`);
        
        res.json({
            success: true,
            prices: prices,
            count: prices.length,
            successCount: successCount,
            failedCount: failedCount,
            elapsed: elapsed,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Bulk price fetch error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch token prices',
            message: error.message
        });
    }
});

// Single token price endpoint - for quick individual checks
app.get('/api/token-price/:contract', async (req, res) => {
    try {
        const { contract } = req.params;
        
        if (!contract) {
            return res.status(400).json({
                success: false,
                error: 'Contract address required'
            });
        }
        
        console.log(`💰 Fetching price for: ${contract.slice(0, 8)}...`);
        
        // DexScreener API
        const url = `https://api.dexscreener.com/latest/dex/tokens/${contract}`;
        const response = await fetch(url);
        
        if (!response.ok) {
            return res.status(response.status).json({
                success: false,
                error: `DexScreener API returned ${response.status}`
            });
        }
        
        const data = await response.json();
        
        if (!data.pairs || data.pairs.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'No trading pairs found for this token'
            });
        }
        
        const pair = data.pairs[0];
        
        res.json({
            success: true,
            contract: contract,
            symbol: pair.baseToken?.symbol || 'UNKNOWN',
            name: pair.baseToken?.name || 'Unknown Token',
            price: pair.priceUsd || '0',
            priceNative: pair.priceNative || '0',
            priceChange: {
                m5: parseFloat(pair.priceChange?.m5 || 0),
                h1: parseFloat(pair.priceChange?.h1 || 0),
                h6: parseFloat(pair.priceChange?.h6 || 0),
                h24: parseFloat(pair.priceChange?.h24 || 0)
            },
            volume: {
                m5: parseFloat(pair.volume?.m5 || 0),
                h1: parseFloat(pair.volume?.h1 || 0),
                h6: parseFloat(pair.volume?.h6 || 0),
                h24: parseFloat(pair.volume?.h24 || 0)
            },
            liquidity: {
                usd: parseFloat(pair.liquidity?.usd || 0)
            },
            txns: {
                m5: pair.txns?.m5 || { buys: 0, sells: 0 },
                h1: pair.txns?.h1 || { buys: 0, sells: 0 },
                h6: pair.txns?.h6 || { buys: 0, sells: 0 },
                h24: pair.txns?.h24 || { buys: 0, sells: 0 }
            },
            pairAddress: pair.pairAddress,
            dexId: pair.dexId,
            url: pair.url,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Token price error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch token price',
            message: error.message
        });
    }
});

// Trigger manual scan (rate limited)
app.get('/api/scan', async (req, res) => {
    try {
        // Run Tier 1 and 2 only (Tier 3 disabled due to high cost/low quality)
        const results = [];
        results.push(...await scanProjects('tier1'));
        results.push(...await scanProjects('tier2'));
        
        res.json({
            success: true,
            message: `Scanned Tier 1 & 2, found ${results.length} new projects`,
            projects: results
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Whale tracker search
app.post('/api/whale/search', async (req, res) => {
    try {
        const { walletAddress, username, limit = 10 } = req.body;
        
        if (!walletAddress || !username) {
            return res.status(400).json({
                success: false,
                error: 'Missing walletAddress or username'
            });
        }
        
        // Check rate limit
        const rateLimit = await checkRateLimit(walletAddress);
        
        if (!rateLimit.allowed) {
            return res.status(429).json({
                success: false,
                error: `Daily limit reached (${rateLimit.count}/10). Resets in ${Math.ceil((24 * 60 * 60 * 1000 - (Date.now() % (24 * 60 * 60 * 1000))) / (60 * 60 * 1000))} hours.`,
                searchesRemaining: 0
            });
        }
        
        // Fetch following
        const following = await fetchUserFollowing(username, limit);
        
        // Log search
        await logWhaleSearch(walletAddress, username, following.length);
        
        res.json({
            success: true,
            searchesRemaining: rateLimit.remaining - 1,
            username: username,
            totalChecked: following.length,
            accounts: following.map(user => ({
                username: user.username,
                name: user.name,
                bio: user.description,
                created: user.created_at,
                followers: user.public_metrics?.followers_count || 0,
                verified: user.verified || false,
                url: user.url || null
            }))
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get stats
app.get('/api/stats', async (req, res) => {
    try {
        const { data: projects } = await supabase
            .from('projects')
            .select('*', { count: 'exact' });
        
        const { data: searches } = await supabase
            .from('whale_searches')
            .select('*', { count: 'exact' })
            .gte('searched_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
        
        res.json({
            success: true,
            stats: {
                totalProjects: projects?.length || 0,
                whaleSearchesToday: searches?.length || 0,
                lastUpdate: new Date().toISOString()
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==========================================
// CRON JOBS
// ==========================================

let scanningEnabled = true; // Control flag

// Pause auto-scanning
app.post('/api/admin/pause', (req, res) => {
    scanningEnabled = false;
    console.log('⏸️ Auto-scanning paused');
    res.json({ success: true, message: 'Auto-scanning paused' });
});

// Resume auto-scanning
app.post('/api/admin/resume', (req, res) => {
    scanningEnabled = true;
    console.log('▶️ Auto-scanning resumed');
    res.json({ success: true, message: 'Auto-scanning resumed' });
});

// Get scanning status
app.get('/api/admin/status', (req, res) => {
    res.json({
        success: true,
        scanningEnabled: scanningEnabled
    });
});

// ==========================================
// LIVE X TRACKER FUNCTIONS
// ==========================================

// Helper: Check if account is crypto-related (basic filter)
function isCryptoRelated(user) {
    const cryptoKeywords = [
        'crypto', 'blockchain', 'defi', 'web3', 'nft', 'dao', 'token',
        'bitcoin', 'ethereum', 'solana', 'protocol', 'dapp', 'smart contract',
        'validator', 'staking', 'yield', 'airdrop', 'presale', 'ico', 'tge'
    ];
    
    const bio = (user.description || '').toLowerCase();
    const name = (user.name || '').toLowerCase();
    
    return cryptoKeywords.some(keyword => bio.includes(keyword) || name.includes(keyword));
}

// Check all tracked whales for new follows
async function checkLiveWhales() {
    console.log('🔴 Checking live tracked whales...');
    
    try {
        // Get all unique whales being tracked
        const { data: trackedWhales, error } = await supabase
            .from('whale_live_tracking')
            .select('whale_username')
            .eq('active', true);
        
        if (error) throw error;
        
        // Get unique whale usernames
        const uniqueWhales = [...new Set(trackedWhales.map(w => w.whale_username))];
        console.log(`📊 Tracking ${uniqueWhales.length} unique whales`);
        
        for (const whaleUsername of uniqueWhales) {
            try {
                console.log(`🔍 Checking @${whaleUsername}...`);
                
                // Fetch current following list
                const currentFollowing = await fetchUserFollowing(whaleUsername, 50);
                const currentUsernames = currentFollowing.map(u => u.username);
                
                // Get previous snapshot
                const { data: snapshot } = await supabase
                    .from('whale_follows_snapshot')
                    .select('following_usernames')
                    .eq('whale_username', whaleUsername)
                    .single();
                
                if (snapshot && snapshot.following_usernames) {
                    // Compare to find new follows
                    const previousUsernames = snapshot.following_usernames;
                    const newFollows = currentFollowing.filter(
                        user => !previousUsernames.includes(user.username)
                    );
                    
                    console.log(`   Found ${newFollows.length} new follows`);
                    
                    // Store ALL new follows (crypto filter removed)
                    console.log(`   Storing all ${newFollows.length} new follows`);
                    
                    // Store new follows as notifications
                    for (const follow of newFollows) {
                        const { error: notifError } = await supabase
                            .from('whale_live_notifications')
                            .insert({
                                whale_username: whaleUsername,
                                followed_username: follow.username,
                                followed_user_data: {
                                    name: follow.name,
                                    bio: follow.description,
                                    followers: follow.public_metrics?.followers_count || 0,
                                    verified: follow.verified || false,
                                    url: follow.url,
                                    profile_image: follow.profile_image_url,
                                    created_at: follow.created_at
                                }
                            })
                            .select()
                            .single();
                        
                        if (!notifError) {
                            console.log(`   ✅ New notification: @${whaleUsername} → @${follow.username}`);
                        }
                    }
                }
                
                // Update snapshot
                await supabase
                    .from('whale_follows_snapshot')
                    .upsert({
                        whale_username: whaleUsername,
                        following_usernames: currentUsernames,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'whale_username' });
                
                // Update last_checked timestamp
                await supabase
                    .from('whale_live_tracking')
                    .update({ last_checked: new Date().toISOString() })
                    .eq('whale_username', whaleUsername)
                    .eq('active', true);
                
            } catch (whaleError) {
                console.error(`Error checking ${whaleUsername}:`, whaleError);
            }
        }
        
        console.log('✅ Live whale check complete');
    } catch (error) {
        console.error('Live whale check error:', error);
    }
}

// ==========================================
// LIVE X TRACKER API ENDPOINTS
// ==========================================

// Add whale to tracking list
app.post('/api/whale/live/track', async (req, res) => {
    try {
        const { userWallet, whaleUsername } = req.body;
        
        if (!userWallet || !whaleUsername) {
            return res.json({ 
                success: false, 
                error: 'Missing userWallet or whaleUsername' 
            });
        }
        
        // Check current tracking count
        const { data: currentTracking, error: countError } = await supabase
            .from('whale_live_tracking')
            .select('id')
            .eq('user_wallet', userWallet)
            .eq('active', true);
        
        if (countError) throw countError;
        
        // Free tier limit: 2 accounts
        const FREE_LIMIT = 2;
        if (currentTracking.length >= FREE_LIMIT) {
            return res.json({
                success: false,
                error: `Free tier limit reached. You can track up to ${FREE_LIMIT} accounts.`,
                limit: FREE_LIMIT,
                current: currentTracking.length
            });
        }
        
        // Add to tracking
        const { data, error } = await supabase
            .from('whale_live_tracking')
            .insert({
                user_wallet: userWallet,
                whale_username: whaleUsername.replace('@', ''),
                check_frequency: 15,
                active: true
            })
            .select()
            .single();
        
        if (error) {
            // Check if already tracking
            if (error.code === '23505') {
                return res.json({
                    success: false,
                    error: 'Already tracking this account'
                });
            }
            throw error;
        }
        
        console.log(`✅ User ${userWallet} now tracking @${whaleUsername}`);
        
        res.json({
            success: true,
            data: data,
            message: `Now tracking @${whaleUsername}`
        });
    } catch (error) {
        console.error('Track whale error:', error);
        res.json({ success: false, error: error.message });
    }
});

// Remove whale from tracking list
app.post('/api/whale/live/untrack', async (req, res) => {
    try {
        const { userWallet, whaleUsername } = req.body;
        
        if (!userWallet || !whaleUsername) {
            return res.json({ 
                success: false, 
                error: 'Missing userWallet or whaleUsername' 
            });
        }
        
        const { error } = await supabase
            .from('whale_live_tracking')
            .delete()
            .eq('user_wallet', userWallet)
            .eq('whale_username', whaleUsername.replace('@', ''));
        
        if (error) throw error;
        
        console.log(`🗑️ User ${userWallet} stopped tracking @${whaleUsername}`);
        
        res.json({
            success: true,
            message: `Stopped tracking @${whaleUsername}`
        });
    } catch (error) {
        console.error('Untrack whale error:', error);
        res.json({ success: false, error: error.message });
    }
});

// Get user's tracking list
app.post('/api/whale/live/list', async (req, res) => {
    try {
        const { userWallet } = req.body;
        
        if (!userWallet) {
            return res.json({ success: false, error: 'Missing userWallet' });
        }
        
        const { data, error } = await supabase
            .from('whale_live_tracking')
            .select('*')
            .eq('user_wallet', userWallet)
            .eq('active', true)
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        
        res.json({
            success: true,
            data: data,
            limit: 2, // Free tier limit
            current: data.length
        });
    } catch (error) {
        console.error('List tracking error:', error);
        res.json({ success: false, error: error.message });
    }
});

// Get notifications for user
app.post('/api/whale/live/notifications', async (req, res) => {
    try {
        const { userWallet, limit = 50 } = req.body;
        
        if (!userWallet) {
            return res.json({ success: false, error: 'Missing userWallet' });
        }
        
        // Get user's tracked whales
        const { data: tracked, error: trackedError } = await supabase
            .from('whale_live_tracking')
            .select('whale_username')
            .eq('user_wallet', userWallet)
            .eq('active', true);
        
        if (trackedError) throw trackedError;
        
        const whaleUsernames = tracked.map(t => t.whale_username);
        
        if (whaleUsernames.length === 0) {
            return res.json({ success: true, data: [], unreadCount: 0 });
        }
        
        // Get notifications for those whales
        const { data: notifications, error: notifError } = await supabase
            .from('whale_live_notifications')
            .select(`
                *,
                whale_user_notifications!left(read, dismissed, read_at)
            `)
            .in('whale_username', whaleUsernames)
            .order('detected_at', { ascending: false })
            .limit(limit);
        
        if (notifError) throw notifError;
        
        // Count unread
        const unreadCount = notifications.filter(n => {
            const userNotif = n.whale_user_notifications.find(un => un.read === false);
            return !n.whale_user_notifications.length || userNotif;
        }).length;
        
        res.json({
            success: true,
            data: notifications,
            unreadCount: unreadCount
        });
    } catch (error) {
        console.error('Get notifications error:', error);
        res.json({ success: false, error: error.message });
    }
});

// Mark notification as read
app.post('/api/whale/live/mark-read', async (req, res) => {
    try {
        const { userWallet, notificationId } = req.body;
        
        if (!userWallet || !notificationId) {
            return res.json({ 
                success: false, 
                error: 'Missing userWallet or notificationId' 
            });
        }
        
        const { error } = await supabase
            .from('whale_user_notifications')
            .upsert({
                user_wallet: userWallet,
                notification_id: notificationId,
                read: true,
                read_at: new Date().toISOString()
            }, { onConflict: 'user_wallet,notification_id' });
        
        if (error) throw error;
        
        res.json({ success: true });
    } catch (error) {
        console.error('Mark read error:', error);
        res.json({ success: false, error: error.message });
    }
});

// Mark all notifications as read
app.post('/api/whale/live/mark-all-read', async (req, res) => {
    try {
        const { userWallet } = req.body;
        
        if (!userWallet) {
            return res.json({ success: false, error: 'Missing userWallet' });
        }
        
        // Get all notification IDs for user's tracked whales
        const { data: tracked } = await supabase
            .from('whale_live_tracking')
            .select('whale_username')
            .eq('user_wallet', userWallet)
            .eq('active', true);
        
        const whaleUsernames = tracked.map(t => t.whale_username);
        
        const { data: notifications } = await supabase
            .from('whale_live_notifications')
            .select('id')
            .in('whale_username', whaleUsernames);
        
        // Mark all as read
        for (const notif of notifications) {
            await supabase
                .from('whale_user_notifications')
                .upsert({
                    user_wallet: userWallet,
                    notification_id: notif.id,
                    read: true,
                    read_at: new Date().toISOString()
                }, { onConflict: 'user_wallet,notification_id' });
        }
        
        res.json({ success: true, marked: notifications.length });
    } catch (error) {
        console.error('Mark all read error:', error);
        res.json({ success: false, error: error.message });
    }
});

// ============================================
// ADMIN ENDPOINTS - Database Management
// ============================================

const ADMIN_KEY = process.env.ADMIN_KEY || 'fallback-admin-key-change-me';

// Middleware to verify admin key
function verifyAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-key'] || req.query.key;
    if (adminKey !== ADMIN_KEY) {
        return res.status(403).json({ 
            success: false, 
            error: 'Unauthorized - Invalid admin key' 
        });
    }
    next();
}

// Get project count
app.get('/api/admin/projects/count', verifyAdmin, async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('projects')
            .select('*', { count: 'exact', head: true });
        
        if (error) throw error;
        
        res.json({ 
            success: true, 
            count: count,
            message: `Currently ${count} projects in database`
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Delete all projects
app.delete('/api/admin/projects/clear-all', verifyAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('projects')
            .delete()
            .not('tweet_id', 'is', null);
        
        if (error) throw error;
        
        const deletedCount = data?.length || 0;
        console.log(`🗑️ ADMIN: Deleted ${deletedCount} projects`);
        res.json({ 
            success: true, 
            deleted: deletedCount,
            message: `Successfully deleted ${deletedCount} projects`,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error deleting projects:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Delete old projects (older than X days)
app.delete('/api/admin/projects/clear-old', verifyAdmin, async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;
        const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        
        const { data, error } = await supabase
            .from('projects')
            .delete()
            .lt('found_at', cutoffDate);
        
        if (error) throw error;
        
        const deletedCount = data?.length || 0;
        console.log(`🗑️ ADMIN: Deleted ${deletedCount} projects older than ${days} days`);
        res.json({ 
            success: true, 
            deleted: deletedCount,
            message: `Deleted ${deletedCount} projects older than ${days} days`
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Delete by filters (e.g., low followers)
app.delete('/api/admin/projects/filter', verifyAdmin, async (req, res) => {
    try {
        const minFollowers = parseInt(req.query.minFollowers) || 100;
        
        const { data, error } = await supabase
            .from('projects')
            .delete()
            .lt('followers', minFollowers);
        
        if (error) throw error;
        
        const deletedCount = data?.length || 0;
        console.log(`🗑️ ADMIN: Deleted ${deletedCount} low-quality projects`);
        res.json({ 
            success: true, 
            deleted: deletedCount,
            message: `Deleted ${deletedCount} projects with < ${minFollowers} followers`
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ==========================================
// CRON JOBS
// ==========================================

// CRON JOBS - Tiered Scanning
// ==========================================

// Reset cross-tier deduplication every hour to prevent memory bloat
cron.schedule('0 * * * *', () => {
    if (global.currentScanProjects) {
        const size = global.currentScanProjects.size;
        global.currentScanProjects.clear();
        console.log(`🔄 Reset cross-tier deduplication (was tracking ${size} projects)`);
    }
});

// TIER 1: Every 5 minutes (high-signal)
cron.schedule('*/5 * * * *', async () => {
    if (!scanningEnabled) return;
    
    console.log('⏰ TIER 1 scan triggered (every 5 min)');
    try {
        await scanProjects('tier1');
    } catch (error) {
        console.error('Tier 1 scan error:', error);
    }
});

// TIER 2: Every 30 minutes (builder signals) - reduced from 15 min for cost savings
cron.schedule('*/30 * * * *', async () => {
    if (!scanningEnabled) return;
    
    console.log('⏰ TIER 2 scan triggered (every 30 min)');
    try {
        await scanProjects('tier2');
    } catch (error) {
        console.error('Tier 2 scan error:', error);
    }
});

// TIER 3: DISABLED (too expensive, low quality results)
// Was costing ~$19/day for mostly spam/bots
// cron.schedule('*/30 * * * *', async () => {
//     if (!scanningEnabled) return;
//     console.log('⏰ TIER 3 scan triggered (every 30 min)');
//     try {
//         await scanProjects('tier3');
//     } catch (error) {
//         console.error('Tier 3 scan error:', error);
//     }
// });

// Live X Tracker - Check every 15 minutes
cron.schedule('*/15 * * * *', async () => {
    console.log('⏰ Live X Tracker check triggered');
    try {
        await checkLiveWhales();
    } catch (error) {
        console.error('Live X Tracker error:', error);
    }
});

// ==========================================
// JUPITER API PROXY (for Chrome Extension)
// ==========================================

// GET /jupiter/quote - Proxy Jupiter quote requests
app.get('/jupiter/quote', async (req, res) => {
    try {
        const url = 'https://api.jup.ag/swap/v1/quote?' + 
            new URLSearchParams(req.query);
        
        console.log('📊 Jupiter quote request:', url);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: { 
                'Accept': 'application/json',
                'x-api-key': process.env.JUPITER_API_KEY
            }
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

// POST /jupiter/swap - Proxy Jupiter swap requests
app.post('/jupiter/swap', async (req, res) => {
    try {
        console.log('🔄 Jupiter swap request');
        
        const response = await fetch('https://api.jup.ag/swap/v1/swap', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-api-key': process.env.JUPITER_API_KEY
            },
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
});
