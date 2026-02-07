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

// Cache for RugCheck data (in-memory, clears on restart)
const rugCheckCache = new Map();
const RUGCHECK_CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

// Rate limiting - RugCheck has strict limits
let lastRugCheckCall = 0;
const RUGCHECK_DELAY = 1200; // 1.2s between calls to avoid 429s

// Helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Clean up old cache entries every 10 minutes
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of rugCheckCache.entries()) {
        if (now - value.timestamp > RUGCHECK_CACHE_TTL) {
            rugCheckCache.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} expired RugCheck cache entries`);
    }
}, 10 * 60 * 1000);

// Fetch RugCheck data for a token (holder %, creator %, score)
async function fetchRugCheckData(contract, retryCount = 0) {
    try {
        // Check cache first
        const cached = rugCheckCache.get(contract);
        if (cached && (Date.now() - cached.timestamp < RUGCHECK_CACHE_TTL)) {
            console.log(`📦 RugCheck cache hit for ${contract.slice(0, 8)}`);
            return cached.data;
        }
        
        // Rate limiting - wait if needed
        const now = Date.now();
        const timeSinceLastCall = now - lastRugCheckCall;
        if (timeSinceLastCall < RUGCHECK_DELAY) {
            await sleep(RUGCHECK_DELAY - timeSinceLastCall);
        }
        lastRugCheckCall = Date.now();
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
        
        let response = await fetch(`https://api.rugcheck.xyz/v1/tokens/${contract}/report`, {
            signal: controller.signal
        });
        clearTimeout(timeout);
        
        // Handle rate limiting (429) - retry with exponential backoff
        if (response.status === 429) {
            if (retryCount < 3) {
                const retryDelay = Math.pow(2, retryCount + 1) * 2000; // 4s, 8s, 16s
                console.log(`⚠️ RugCheck 429 for ${contract.slice(0, 8)}, retry ${retryCount + 1}/3 in ${retryDelay/1000}s...`);
                await sleep(retryDelay);
                lastRugCheckCall = Date.now(); // Reset rate limit timer
                return fetchRugCheckData(contract, retryCount + 1);
            } else {
                console.log(`❌ RugCheck 429 for ${contract.slice(0, 8)} - max retries exceeded`);
                return null;
            }
        }
        
        if (!response.ok) {
            console.log(`⚠️ RugCheck ${response.status} for ${contract.slice(0, 8)}`);
            return null;
        }
        
        const data = await response.json();
        
        // Check if creator has rugged before (look in risks array)
        const creatorRugRisk = data.risks?.find(r => 
            r.name?.toLowerCase().includes('creator history') || 
            r.name?.toLowerCase().includes('rugged tokens') ||
            r.description?.toLowerCase().includes('history of rugging') ||
            r.name?.toLowerCase().includes('previous rug')
        );
        
        // =====================================================
        // CREATOR HOLDINGS - Try multiple possible formats
        // =====================================================
        let creatorPercent = null;
        
        // Method 1: Check if creatorTokens has pct directly
        if (data.creatorTokens?.pct !== undefined) {
            const pct = data.creatorTokens.pct;
            creatorPercent = pct > 1 ? pct.toFixed(2) + '%' : (pct * 100).toFixed(2) + '%';
        }
        // Method 2: Check if there's a creatorPercentage field
        else if (data.creatorPercentage !== undefined) {
            creatorPercent = data.creatorPercentage.toFixed(2) + '%';
        }
        // Method 3: Calculate from balance and supply
        else if (data.token?.supply && data.creatorBalance) {
            const supply = typeof data.token.supply === 'string' ? parseFloat(data.token.supply) : data.token.supply;
            const balance = typeof data.creatorBalance === 'string' ? parseFloat(data.creatorBalance) : data.creatorBalance;
            if (supply > 0) {
                creatorPercent = ((balance / supply) * 100).toFixed(2) + '%';
            }
        }
        // Method 4: Check creatorTokens.percentage
        else if (data.creatorTokens?.percentage !== undefined) {
            creatorPercent = data.creatorTokens.percentage.toFixed(2) + '%';
        }
        // Method 5: Look in tokenOverview
        else if (data.tokenOverview?.creatorBalance?.percentage !== undefined) {
            creatorPercent = data.tokenOverview.creatorBalance.percentage.toFixed(2) + '%';
        }
        
        // =====================================================
        // TOP 20 HOLDERS - Try multiple possible formats  
        // =====================================================
        let top20Percent = null;
        let top20Addresses = []; // Store addresses for fresh wallet check
        
        if (data.topHolders && data.topHolders.length > 0) {
            console.log(`   ↳ RugCheck returned ${data.topHolders.length} holders`);
            let top20Total = 0;
            let holdersIncluded = 0;
            const TARGET_HOLDERS = 20;
            
            // Iterate through ALL holders until we have 20 non-LP holders
            for (const holder of data.topHolders) {
                if (holdersIncluded >= TARGET_HOLDERS) break;
                
                // Get holder percentage
                let holderPct = holder.pct || holder.percentage || holder.percent || holder.pctOwned || 0;
                
                // If it's a decimal (0.0189), convert to percentage
                if (holderPct > 0 && holderPct < 1) {
                    holderPct = holderPct * 100;
                }
                
                // Build searchable string from all possible fields
                const searchStr = [
                    holder.address,
                    holder.owner,
                    holder.label,
                    holder.name,
                    holder.tag,
                    holder.type
                ].filter(Boolean).join(' ').toLowerCase();
                
                // Skip LP/AMM addresses (Pump.fun, Raydium, Orca, Meteora, etc.)
                const isLP = holder.isLP || 
                    holder.isLiquidity ||
                    holder.isAMM ||
                    searchStr.includes('pump') ||
                    searchStr.includes('amm') ||
                    searchStr.includes('lp') ||
                    searchStr.includes('liquidity') ||
                    searchStr.includes('raydium') ||
                    searchStr.includes('orca') ||
                    searchStr.includes('meteora') ||
                    searchStr.includes('bonding') ||
                    // Skip if holder has >50% (almost certainly LP/AMM)
                    holderPct > 50;
                
                if (isLP) {
                    console.log(`   ↳ Skipping LP/AMM: ${holder.address?.slice(0, 8) || 'unknown'} (${holderPct.toFixed(2)}%)`);
                    continue;
                }
                
                top20Total += holderPct;
                holdersIncluded++;
                
                // Store address AND percentage for fresh wallet check
                const addr = holder.address || holder.owner;
                if (addr) {
                    top20Addresses.push({ address: addr, percent: holderPct });
                }
            }
            
            // Sanity check: cap at 100%
            if (top20Total > 100) {
                console.warn(`   ⚠️ Top 20 total was ${top20Total.toFixed(2)}% - capping at 100%`);
                top20Total = 100;
            }
            
            if (top20Total > 0) {
                top20Percent = top20Total.toFixed(2) + '%';
                console.log(`   ↳ Got ${holdersIncluded} holders (excl. LP), addresses: ${top20Addresses.length}`);
            }
        }
        
        // Fallback: Check pre-calculated fields
        if (!top20Percent && data.totalTopHoldersPercent !== undefined) {
            top20Percent = data.totalTopHoldersPercent.toFixed(2) + '%';
        }
        if (!top20Percent && data.tokenMeta?.topHoldersPercent !== undefined) {
            top20Percent = data.tokenMeta.topHoldersPercent.toFixed(2) + '%';
        }
        
        console.log(`✅ RugCheck for ${contract.slice(0, 8)}: creator=${creatorPercent}, top20=${top20Percent}`);
        
        const result = {
            score: Math.round((data.score || 0) / 10),
            topHolders: data.topHolders || null,
            top20Percent: top20Percent,
            top20Addresses: top20Addresses,
            creator: data.creator || null,
            creatorBalance: data.creatorBalance || null,
            creatorPercent: creatorPercent,
            creatorHasRugged: !!creatorRugRisk,
            creatorRugRisk: creatorRugRisk || null,
            risks: data.risks || [],
            rugged: data.rugged || false,
            markets: data.markets || []
        };
        
        // Cache the result
        rugCheckCache.set(contract, { data: result, timestamp: Date.now() });
        
        return result;
    } catch (error) {
        console.log(`⚠️ RugCheck error for ${contract.slice(0, 8)}:`, error.message);
        return null;
    }
}

// ==========================================
// FRESH WALLET DETECTION (Helius API)
// ==========================================

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_API_URL = `https://api.helius.xyz/v0`;

// Check if a wallet is "fresh" (< 24 hours old AND < 10 transactions)
async function checkWalletFreshness(walletAddress) {
    try {
        // Get transaction signatures for this wallet (limit 10 to check count)
        const response = await fetch(HELIUS_RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getSignaturesForAddress',
                params: [
                    walletAddress,
                    { limit: 10 }
                ]
            })
        });
        
        if (!response.ok) {
            return { fresh: false, error: 'API error' };
        }
        
        const data = await response.json();
        const signatures = data.result || [];
        
        if (signatures.length === 0) {
            // No transactions = very fresh
            return { fresh: true, txCount: 0, ageHours: 0 };
        }
        
        const txCount = signatures.length;
        
        // Get the oldest transaction timestamp (last in array since it's newest first)
        // We need to make another call to get older transactions if there are exactly 10
        let oldestTimestamp;
        
        if (txCount < 10) {
            // Less than 10 transactions, oldest is last in this array
            oldestTimestamp = signatures[signatures.length - 1]?.blockTime;
        } else {
            // Has 10+ transactions - not fresh by tx count
            return { fresh: false, txCount: '10+', reason: 'too many transactions' };
        }
        
        if (!oldestTimestamp) {
            return { fresh: false, error: 'no timestamp' };
        }
        
        // Calculate wallet age in hours
        const ageMs = Date.now() - (oldestTimestamp * 1000);
        const ageHours = ageMs / (1000 * 60 * 60);
        
        // Fresh = less than 24 hours old AND less than 10 transactions
        const isFresh = ageHours < 24 && txCount < 10;
        
        return {
            fresh: isFresh,
            txCount: txCount,
            ageHours: Math.round(ageHours * 10) / 10
        };
        
    } catch (error) {
        console.log(`   ⚠️ Fresh check error for ${walletAddress.slice(0, 8)}: ${error.message}`);
        return { fresh: false, error: error.message };
    }
}

// Check freshness for multiple wallets (top 20 holders)
// walletData is array of { address, percent }
async function checkFreshWallets(walletData) {
    if (!walletData || walletData.length === 0) {
        return { freshCount: 0, totalChecked: 0, freshHoldingsPercent: '0%', display: '0/0 (0%)' };
    }
    
    console.log(`   🔍 Checking freshness for ${walletData.length} wallets...`);
    
    // Check all wallets in parallel
    const results = await Promise.all(
        walletData.map(async (holder) => {
            const freshResult = await checkWalletFreshness(holder.address);
            return {
                ...freshResult,
                percent: holder.percent
            };
        })
    );
    
    // Count fresh wallets and sum their holdings
    let freshCount = 0;
    let freshHoldings = 0;
    
    for (const result of results) {
        if (result.fresh) {
            freshCount++;
            freshHoldings += result.percent || 0;
        }
    }
    
    const totalChecked = walletData.length;
    const freshHoldingsPercent = freshHoldings.toFixed(1) + '%';
    
    console.log(`   ✅ Fresh wallets: ${freshCount}/${totalChecked} holding ${freshHoldingsPercent}`);
    
    return {
        freshCount,
        totalChecked,
        freshHoldingsPercent,
        display: `${freshCount}/${totalChecked} (${freshHoldingsPercent})`
    };
}

// ==========================================
// REFRESH ENDPOINT (Holders + Price + Liquidity + Fresh)
// ==========================================

// Refresh all data for a single token
app.get('/api/refresh/:contract', async (req, res) => {
    try {
        const { contract } = req.params;
        
        if (!contract) {
            return res.status(400).json({ error: 'Contract address required' });
        }
        
        console.log(`🔄 Refreshing all data for ${contract}`);
        
        // Clear cache for this token to force fresh fetch
        rugCheckCache.delete(contract);
        
        // Fetch holder data and price/liquidity in parallel
        const [rugCheckData, priceData] = await Promise.all([
            fetchRugCheckData(contract),
            fetchPriceAndLiquidity(contract)
        ]);
        
        // Now check fresh wallets using the top 20 addresses
        const freshData = await checkFreshWallets(rugCheckData?.top20Addresses || []);
        
        const response_data = {
            success: true,
            contract: contract,
            creatorPercent: rugCheckData?.creatorPercent || null,
            top20HoldersPercent: rugCheckData?.top20Percent || null,
            freshWallets: freshData,
            price: priceData?.price || null,
            liquidity: priceData?.liquidity || null
        };
        
        console.log(`🔄 Refresh response for ${contract.slice(0, 8)}:`, JSON.stringify(response_data));
        
        res.json(response_data);
        
    } catch (error) {
        console.error('Refresh error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            contract: req.params.contract
        });
    }
});

// Helper function to fetch price and liquidity from DexScreener (with Jupiter fallback)
async function fetchPriceAndLiquidity(contract) {
    // Try DexScreener first
    try {
        console.log(`   💰 Fetching price/liquidity for ${contract.slice(0, 8)}...`);
        const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${contract}`;
        const response = await fetch(dexUrl);
        
        if (response.status === 429) {
            console.log(`   ⚠️ DexScreener rate limited, trying Jupiter...`);
            return await fetchPriceFromJupiter(contract);
        }
        
        if (!response.ok) {
            console.log(`   ❌ DexScreener API error: ${response.status}, trying Jupiter...`);
            return await fetchPriceFromJupiter(contract);
        }
        
        const data = await response.json();
        
        if (data.pairs && data.pairs.length > 0) {
            // Find the pair with highest liquidity
            const bestPair = data.pairs.reduce((best, pair) => {
                const pairLiq = pair.liquidity?.usd || 0;
                const bestLiq = best?.liquidity?.usd || 0;
                return pairLiq > bestLiq ? pair : best;
            }, data.pairs[0]);
            
            const result = {
                price: parseFloat(bestPair.priceUsd) || 0,
                liquidity: bestPair.liquidity?.usd || 0
            };
            console.log(`   ✅ DexScreener: Price $${result.price}, Liq $${result.liquidity}`);
            return result;
        }
        
        console.log(`   ⚠️ No DexScreener pairs, trying Jupiter...`);
        return await fetchPriceFromJupiter(contract);
    } catch (error) {
        console.log(`   ❌ DexScreener error: ${error.message}, trying Jupiter...`);
        return await fetchPriceFromJupiter(contract);
    }
}

// Fallback: Jupiter Price API
async function fetchPriceFromJupiter(contract) {
    try {
        const jupiterUrl = `https://api.jup.ag/price/v2?ids=${contract}`;
        const response = await fetch(jupiterUrl);
        
        if (!response.ok) {
            console.log(`   ❌ Jupiter API error: ${response.status}`);
            return null;
        }
        
        const data = await response.json();
        
        if (data.data && data.data[contract]) {
            const price = parseFloat(data.data[contract].price) || 0;
            console.log(`   ✅ Jupiter: Price $${price} (no liquidity data)`);
            return {
                price: price,
                liquidity: null  // Jupiter doesn't provide liquidity
            };
        }
        
        console.log(`   ⚠️ No Jupiter price data`);
        return null;
    } catch (error) {
        console.log(`   ❌ Jupiter error: ${error.message}`);
        return null;
    }
}

// Live Launches - Get graduated Pump.fun tokens (using Moralis API)
// Track last check time to only show NEW graduations going forward
// FIX: Start by looking back 1 hour (3600000ms) instead of starting from "now"
let lastGraduationCheck = Date.now() - (60 * 60 * 1000); // Look back 1 hour on startup
let lastMeteoraCheck = Date.now() - (60 * 60 * 1000); // Look back 1 hour on startup for Meteora

// Rolling cache - keeps tokens for 1 hour so all users can see them
// Frontend handles dismissals per-user
const TOKEN_CACHE_DURATION = 60 * 60 * 1000; // 1 hour in ms
let rollingTokenCache = []; // Array of {token, addedAt}

function cleanupTokenCache() {
    const cutoff = Date.now() - TOKEN_CACHE_DURATION;
    const before = rollingTokenCache.length;
    rollingTokenCache = rollingTokenCache.filter(item => item.addedAt > cutoff);
    const removed = before - rollingTokenCache.length;
    if (removed > 0) {
        console.log(`🧹 Cleaned ${removed} expired tokens from cache (${rollingTokenCache.length} remaining)`);
    }
}

function addTokensToCache(tokens) {
    const now = Date.now();
    const existingContracts = new Set(rollingTokenCache.map(item => item.token.contract));
    
    let added = 0;
    for (const token of tokens) {
        if (!existingContracts.has(token.contract)) {
            rollingTokenCache.push({ token, addedAt: now });
            added++;
        }
    }
    if (added > 0) {
        console.log(`📥 Added ${added} new tokens to rolling cache (${rollingTokenCache.length} total)`);
    }
}

function getCachedTokens() {
    cleanupTokenCache();
    const now = Date.now();
    
    // Recalculate ageMinutes for each cached token
    return rollingTokenCache.map(item => {
        const token = { ...item.token };
        if (token.graduatedAt) {
            const gradTime = typeof token.graduatedAt === 'number' 
                ? token.graduatedAt 
                : new Date(token.graduatedAt).getTime();
            token.ageMinutes = Math.floor((now - gradTime) / (1000 * 60));
        }
        return token;
    });
}

// Meteora Dynamic Bonding Curve Program ID
const METEORA_DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';

// Fetch Meteora DBC migrations from Helius
async function fetchMeteoraMigrations() {
    if (!HELIUS_API_KEY) {
        console.log('⚠️ HELIUS_API_KEY not set - skipping Meteora DBC');
        return [];
    }
    
    try {
        console.log('🔍 Fetching Meteora DBC migrations from Helius...');
        
        // Get recent transactions for the DBC program
        const response = await fetch(
            `${HELIUS_API_URL}/addresses/${METEORA_DBC_PROGRAM}/transactions?api-key=${HELIUS_API_KEY}&limit=50`,
            { headers: { 'Accept': 'application/json' } }
        );
        
        if (!response.ok) {
            console.error(`Helius API error: ${response.status}`);
            return [];
        }
        
        const transactions = await response.json();
        console.log(`📦 Helius returned ${transactions.length} DBC transactions`);
        
        // Filter for migration transactions only
        const migrations = [];
        for (const tx of transactions) {
            // Check if this is a migration transaction
            const isMigration = tx.type === 'UNKNOWN' && tx.instructions?.some(ix => 
                ix.programId === METEORA_DBC_PROGRAM && 
                (ix.data?.includes('migrate') || tx.description?.toLowerCase().includes('migrat'))
            );
            
            // Also check parsed instructions for migration methods
            const hasMigrationMethod = tx.instructions?.some(ix => {
                const data = ix.data || '';
                // Check for migrate_meteora_damm or migration_damm_v2 method signatures
                return ix.programId === METEORA_DBC_PROGRAM;
            });
            
            // Get token mint from accounts (usually in the transaction accounts)
            let tokenMint = null;
            if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
                tokenMint = tx.tokenTransfers[0].mint;
            } else if (tx.accountData) {
                // Look for token mint in account data
                for (const acc of tx.accountData) {
                    if (acc.tokenBalanceChanges && acc.tokenBalanceChanges.length > 0) {
                        tokenMint = acc.tokenBalanceChanges[0].mint;
                        break;
                    }
                }
            }
            
            // If we found a token mint and this looks like a DBC transaction, include it
            if (tokenMint && tx.timestamp && hasMigrationMethod) {
                migrations.push({
                    tokenMint,
                    timestamp: tx.timestamp * 1000, // Convert to milliseconds
                    signature: tx.signature
                });
            }
        }
        
        console.log(`📊 Found ${migrations.length} potential Meteora migrations`);
        return migrations;
        
    } catch (error) {
        console.error('❌ Meteora DBC fetch error:', error.message);
        return [];
    }
}

// Fetch token metadata from Helius DAS API
async function fetchTokenMetadata(tokenMint) {
    if (!HELIUS_API_KEY) return null;
    
    try {
        const response = await fetch(HELIUS_RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'metadata',
                method: 'getAsset',
                params: { id: tokenMint }
            })
        });
        
        if (!response.ok) return null;
        
        const data = await response.json();
        if (data.result) {
            return {
                name: data.result.content?.metadata?.name || 'Unknown',
                symbol: data.result.content?.metadata?.symbol || 'UNKNOWN',
                decimals: data.result.token_info?.decimals || 6,
                logo: data.result.content?.links?.image || null
            };
        }
        return null;
    } catch (error) {
        console.error(`Metadata fetch error for ${tokenMint.slice(0,8)}:`, error.message);
        return null;
    }
}

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
        console.log('🔍 Fetching graduated tokens from Pump.fun + Meteora DBC...');
        
        const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
        const currentCheckTime = Date.now();
        
        // ========================================
        // 1. FETCH PUMP.FUN GRADUATIONS (Moralis)
        // ========================================
        let pumpTokens = [];
        if (MORALIS_API_KEY) {
            try {
                const response = await fetch('https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/graduated', {
                    headers: {
                        'Accept': 'application/json',
                        'X-API-Key': MORALIS_API_KEY
                    }
                });
                
                if (response.ok) {
                    const data = await response.json();
                    // Handle different response formats
                    if (Array.isArray(data)) {
                        pumpTokens = data;
                    } else if (data.result && Array.isArray(data.result)) {
                        pumpTokens = data.result;
                    } else if (data.tokens && Array.isArray(data.tokens)) {
                        pumpTokens = data.tokens;
                    } else if (data.data && Array.isArray(data.data)) {
                        pumpTokens = data.data;
                    }
                    console.log(`📊 Moralis returned ${pumpTokens.length} Pump.fun graduations`);
                }
            } catch (err) {
                console.error('⚠️ Moralis fetch error:', err.message);
            }
        } else {
            console.log('⚠️ MORALIS_API_KEY not set - skipping Pump.fun');
        }
        
        // ========================================
        // 2. METEORA DBC - DISABLED
        // ========================================
        // DISABLED: Causing excessive Helius API usage and returning old tokens
        // TODO: Fix before re-enabling
        let meteoraTokens = [];
        let heliusCallCount = 0;
        console.log('⚠️ Meteora DBC detection DISABLED - using Pump.fun only');
        // ========================================
        // 3. FILTER PUMP.FUN BY TIME
        // ========================================
        console.log(`⏰ Pump.fun last check: ${new Date(lastGraduationCheck).toISOString()}`);
        console.log(`⏰ Meteora last check: ${new Date(lastMeteoraCheck).toISOString()}`);
        
        let pumpOldCount = 0;
        const newPumpGraduations = pumpTokens.filter(token => {
            const address = token.address || token.mint || token.token_address || token.tokenAddress;
            if (!address) return false;
            
            const graduatedAt = token.graduated_at || token.graduatedAt || token.migration_timestamp || token.timestamp;
            if (!graduatedAt) return false;
            
            const graduatedTime = typeof graduatedAt === 'number' ? graduatedAt : new Date(graduatedAt).getTime();
            
            if (graduatedTime <= lastGraduationCheck) {
                pumpOldCount++;
                return false;
            }
            return true;
        });
        
        console.log(`✅ Found ${newPumpGraduations.length} NEW Pump.fun graduations (skipped ${pumpOldCount} old)`);
        console.log(`✅ Found ${meteoraTokens.length} NEW Meteora DBC migrations`);
        console.log(`📊 Meteora Helius calls this poll: ${heliusCallCount}`);
        
        // NOTE: We update lastGraduationCheck AFTER adding to cache (see below)
        // This prevents race conditions where User B polls before User A's tokens are cached
        
        // ========================================
        // 4. METEORA METADATA - ALREADY FROM DEXSCREENER
        // ========================================
        // Metadata (name, symbol, price, liquidity) already captured during validation
        // No additional Helius calls needed!
        
        // ========================================
        // 5. COMBINE ALL TOKENS
        // ========================================
        const allNewTokens = [
            // Pump.fun tokens with source tag
            ...newPumpGraduations.map(token => ({
                ...token,
                _source: 'Pump',
                _address: token.address || token.mint || token.token_address || token.tokenAddress,
                _graduatedAt: token.graduated_at || token.graduatedAt || token.migration_timestamp || token.timestamp
            })),
            // Meteora tokens with source tag (metadata from DexScreener validation)
            ...meteoraTokens.map(token => {
                return {
                    _source: 'Meteora',
                    _address: token.mint,
                    _graduatedAt: token.timestamp,
                    symbol: token.symbol || 'UNKNOWN',
                    name: token.name || 'Unknown Token',
                    logo: token.logo || null,
                    liquidity: token.liquidity,
                    price: token.price
                };
            })
        ];
        
        console.log(`📊 Total new tokens to process: ${allNewTokens.length}`);
        
        if (allNewTokens.length === 0) {
            // No new tokens, but return cached tokens from last hour
            const cachedTokens = getCachedTokens();
            console.log(`📦 Returning ${cachedTokens.length} tokens from cache (no new tokens this poll)`);
            return res.json({
                success: true,
                launches: cachedTokens,
                totalScanned: pumpTokens.length + meteoraTokens.length,
                count: cachedTokens.length,
                timestamp: new Date().toISOString(),
                message: `No new tokens (returning ${cachedTokens.length} from cache)`,
                scamFilterRate: '0%'
            });
        }
        
        // ========================================
        // 6. FETCH RUGCHECK DATA
        // ========================================
        console.log(`📊 Fetching RugCheck data for ${allNewTokens.length} tokens...`);
        const rugCheckMap = new Map();
        
        // RugCheck sequential
        for (const token of allNewTokens) {
            try {
                const rugCheckData = await fetchRugCheckData(token._address);
                rugCheckMap.set(token._address, rugCheckData);
            } catch (err) {
                rugCheckMap.set(token._address, null);
            }
        }
        
        console.log(`✅ RugCheck complete`);
        
        // ========================================
        // 6b. FETCH FRESH WALLET DATA
        // ========================================
        console.log(`🔍 Checking fresh wallets for ${allNewTokens.length} tokens...`);
        const freshWalletMap = new Map();
        
        // Check fresh wallets in parallel for all tokens
        await Promise.all(allNewTokens.map(async (token) => {
            try {
                const rugCheck = rugCheckMap.get(token._address);
                if (rugCheck?.top20Addresses && rugCheck.top20Addresses.length > 0) {
                    const freshData = await checkFreshWallets(rugCheck.top20Addresses);
                    freshWalletMap.set(token._address, freshData);
                } else {
                    freshWalletMap.set(token._address, null);
                }
            } catch (err) {
                console.log(`   ⚠️ Fresh check failed for ${token._address.slice(0, 8)}: ${err.message}`);
                freshWalletMap.set(token._address, null);
            }
        }));
        
        console.log(`✅ Fresh wallet check complete`);
        
        // ========================================
        // 7. FORMAT FINAL RESULTS
        // ========================================
        const formatted = allNewTokens.map(token => {
            const address = token._address;
            const graduatedAt = token._graduatedAt;
            const rugCheck = rugCheckMap.get(address);
            const freshWallets = freshWalletMap.get(address);
            const source = token._source;
            
            const ageMinutes = graduatedAt 
                ? Math.floor((currentCheckTime - (typeof graduatedAt === 'number' ? graduatedAt : new Date(graduatedAt).getTime())) / (1000 * 60))
                : 0;
            
            return {
                symbol: token.symbol || 'UNKNOWN',
                name: token.name || 'Unknown Token',
                contract: address,
                source: source, // 'Pump' or 'Meteora'
                ageMinutes: ageMinutes,
                liquidity: token.liquidity || token.reserve_in_usd || token.raydium_liquidity || 0,
                price: token.priceUsd || token.price_usd || token.price || token.priceNative || 0,
                dex: source === 'Pump' ? 'raydium' : 'meteora',
                hasLogo: !!token.logo || !!token.image_uri || !!token.logoURI,
                hasWebsite: !!token.website,
                hasSocials: !!(token.twitter || token.telegram),
                website: token.website || null,
                dexscreenerUrl: `https://dexscreener.com/solana/${address}`,
                jupiterUrl: `https://jup.ag/?sell=So11111111111111111111111111111111111111112&buy=${address}`,
                raydiumUrl: source === 'Pump' 
                    ? `https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${address}`
                    : `https://app.meteora.ag/pools?token=${address}`,
                priceChange: {
                    m5: token.priceChange5m || token.price_change_5m || token.priceChange?.['5m'] || 0,
                    h1: token.priceChange1h || token.price_change_1h || token.priceChange?.['1h'] || 0
                },
                graduated: true,
                marketCap: token.market_cap || token.marketCap || 0,
                graduatedAt: graduatedAt,
                // RugCheck data
                rugCheckScore: rugCheck?.score || 0,
                top20HoldersPercent: rugCheck?.top20Percent || null,
                top20Addresses: rugCheck?.top20Addresses || [],
                creatorAddress: rugCheck?.creator || null,
                creatorPercent: rugCheck?.creatorPercent || null,
                creatorHasRugged: rugCheck?.creatorHasRugged || false,
                rugCheckRisks: rugCheck?.risks || [],
                isRugged: rugCheck?.rugged || false,
                freshWallets: freshWallets || null
            };
        });
        
        // Add newly formatted tokens to rolling cache
        addTokensToCache(formatted);
        
        // NOW update check times (after cache is populated)
        // This prevents race conditions between users
        lastGraduationCheck = currentCheckTime;
        lastMeteoraCheck = currentCheckTime;
        
        // Return ALL cached tokens (includes new ones + previous hour)
        const allCachedTokens = getCachedTokens();
        
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            totalScanned: pumpTokens.length + meteoraTokens.length,
            launches: allCachedTokens,
            count: allCachedTokens.length,
            newThisPoll: formatted.length,
            message: `New: ${formatted.length} | Cached: ${allCachedTokens.length} (Pump: ${newPumpGraduations.length}, Meteora: ${meteoraTokens.length})`,
            scamFilterRate: '0%'
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
                // Try DexScreener first (best for graduated tokens)
                const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${contract}`;
                const dexController = new AbortController();
                const dexTimeout = setTimeout(() => dexController.abort(), 3000); // 3s timeout
                
                const dexResponse = await fetch(dexUrl, {
                    signal: dexController.signal
                });
                clearTimeout(dexTimeout);
                
                if (dexResponse.ok) {
                    const dexData = await dexResponse.json();
                    
                    if (dexData.pairs && dexData.pairs.length > 0) {
                        const pair = dexData.pairs[0];
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
                            url: pair.url,
                            source: 'dexscreener'
                        };
                    }
                }
                
                // DexScreener failed or no pairs - try Jupiter Price API (works for Pump.fun tokens)
                console.log(`   DexScreener no data for ${contract.slice(0, 8)}, trying Jupiter...`);
                const jupUrl = `https://price.jup.ag/v6/price?ids=${contract}`;
                const jupController = new AbortController();
                const jupTimeout = setTimeout(() => jupController.abort(), 3000);
                
                const jupResponse = await fetch(jupUrl, {
                    signal: jupController.signal
                });
                clearTimeout(jupTimeout);
                
                if (jupResponse.ok) {
                    const jupData = await jupResponse.json();
                    const priceData = jupData.data?.[contract];
                    
                    if (priceData && priceData.price) {
                        console.log(`   ✅ Jupiter got price for ${contract.slice(0, 8)}: $${priceData.price}`);
                        return {
                            contract: contract,
                            success: true,
                            price: priceData.price.toString(),
                            priceNative: '0', // Jupiter doesn't provide native price easily
                            priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 },
                            volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
                            liquidity: { usd: 0, base: 0, quote: 0 },
                            source: 'jupiter'
                        };
                    }
                }
                
                // Both APIs failed
                console.log(`   ❌ No price found for ${contract.slice(0, 8)} (DexScreener + Jupiter failed)`);
                return {
                    contract: contract,
                    success: false,
                    error: 'No trading pairs found (tried DexScreener + Jupiter)'
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
// RUGCHECK DEBUG ENDPOINT
// ==========================================

// Debug endpoint to test RugCheck API response directly
// Usage: GET /api/debug/rugcheck/:contract
app.get('/api/debug/rugcheck/:contract', async (req, res) => {
    try {
        const { contract } = req.params;
        
        if (!contract) {
            return res.status(400).json({ error: 'Contract address required' });
        }
        
        console.log(`🔍 Debug: Fetching raw RugCheck data for ${contract}`);
        
        // Fetch raw data from RugCheck
        const response = await fetch(`https://api.rugcheck.xyz/v1/tokens/${contract}/report`);
        
        if (!response.ok) {
            return res.status(response.status).json({
                error: `RugCheck API returned ${response.status}`,
                contract: contract
            });
        }
        
        const rawData = await response.json();
        
        // Also run through our parser
        const parsedData = await fetchRugCheckData(contract);
        
        res.json({
            success: true,
            contract: contract,
            raw: rawData,  // Full raw response from RugCheck
            parsed: parsedData,  // What our parser extracts
            debug: {
                rawKeys: Object.keys(rawData),
                hasTopHolders: !!rawData.topHolders,
                topHoldersSample: rawData.topHolders?.slice(0, 3),
                hasCreatorTokens: !!rawData.creatorTokens,
                creatorTokensData: rawData.creatorTokens,
                tokenData: rawData.token,
                creatorBalance: rawData.creatorBalance,
                score: rawData.score
            }
        });
        
    } catch (error) {
        console.error('Debug RugCheck error:', error);
        res.status(500).json({
            error: error.message,
            contract: req.params.contract
        });
    }
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
