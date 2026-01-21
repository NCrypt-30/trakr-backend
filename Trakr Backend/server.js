const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

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

const SEARCH_TERMS = [
    'blockchain launching soon',
    'protocol launching soon',
    'crypto launching soon',
    'web3 launching soon',
    'DeFi launching soon',
    'NFT project launching',
    'testnet launching',
    'testnet live',
    'mainnet launching',
    'mainnet coming soon',
    'devnet live',
    'smart contract deployed',
    'no token yet',
    'pre-token',
    'before TGE',
    'TGE coming soon',
    'token launch soon',
    'airdrop soon',
    'rollup launching',
    'DeFi protocol launching',
    'DEX launching',
    'lending protocol',
    'liquid staking',
    'AI agent crypto',
    'AI blockchain',
    'DePIN launching',
    'RWA project launching',
    'shipping web3',
    'stealth crypto project',
    'stealth blockchain',
    'building in stealth web3',
    'stealth launch',
    'stealth launching'
];

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

// Scan X API for projects
async function scanProjects(numQueries = 5) {
    console.log(`🔍 Starting scan with ${numQueries} queries...`);
    
    // Pick random queries
    const queries = [];
    const usedIndices = new Set();
    while (queries.length < numQueries && queries.length < SEARCH_TERMS.length) {
        const idx = Math.floor(Math.random() * SEARCH_TERMS.length);
        if (!usedIndices.has(idx)) {
            usedIndices.add(idx);
            queries.push(SEARCH_TERMS[idx]);
        }
    }
    
    const allProjects = [];
    
    for (const query of queries) {
        try {
            const params = new URLSearchParams({
                query: query,
                'max_results': '10',
                'tweet.fields': 'created_at,public_metrics',
                'user.fields': 'username,public_metrics,description,verified,created_at,url',
                'expansions': 'author_id'
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
                console.error(`Query "${query}" failed`);
                continue;
            }
            
            const data = await response.json();
            
            if (!data.data || data.data.length === 0) continue;
            
            // Build user map
            const users = {};
            if (data.includes && data.includes.users) {
                data.includes.users.forEach(user => {
                    users[user.id] = user;
                });
            }
            
            // Parse tweets
            for (const tweet of data.data) {
                const user = users[tweet.author_id] || {};
                const projectHandle = extractProjectHandle(tweet.text);
                
                if (!projectHandle) continue;
                
                allProjects.push({
                    tweet_id: tweet.id,
                    project_handle: projectHandle,
                    tweet_text: tweet.text,
                    tweet_author: user.username,
                    tweet_url: `https://twitter.com/${user.username}/status/${tweet.id}`,
                    project_url: `https://twitter.com/${projectHandle}`,
                    found_by_query: query
                });
            }
            
            // Small delay
            await new Promise(resolve => setTimeout(resolve, 100));
            
        } catch (error) {
            console.error(`Error with query "${query}":`, error.message);
        }
    }
    
    console.log(`📊 Found ${allProjects.length} tweets with project mentions`);
    
    // Deduplicate by tweet_id
    const unique = [];
    const seenIds = new Set();
    for (const proj of allProjects) {
        if (!seenIds.has(proj.tweet_id)) {
            seenIds.add(proj.tweet_id);
            unique.push(proj);
        }
    }
    
    console.log(`🎯 ${unique.length} unique tweets after deduplication`);
    
    console.log(`✅ Found ${unique.length} unique projects from search`);
    
    // Map projects without verification (save API calls!)
    const projects = unique.map(proj => ({
        ...proj,
        account_created: null, // Unknown
        followers: 0,
        verified: false,
        bio: ''
    }));
    
    // Save to database
    if (projects.length > 0) {
        const { error } = await supabase
            .from('projects')
            .upsert(projects.map(p => ({
                tweet_id: p.tweet_id,
                project_handle: p.project_handle,
                tweet_text: p.tweet_text,
                tweet_author: p.tweet_author,
                tweet_url: p.tweet_url,
                project_url: p.project_url,
                account_created: p.account_created,
                followers: p.followers,
                verified: p.verified,
                bio: p.bio,
                found_by_query: p.found_by_query,
                found_at: new Date().toISOString()
            })), {
                onConflict: 'tweet_id'
            });
        
        if (error) {
            console.error('❌ Database error:', error);
        } else {
            console.log(`💾 Saved ${projects.length} projects to database`);
        }
    }
    
    return projects;
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

// Trigger manual scan (rate limited)
app.get('/api/scan', async (req, res) => {
    try {
        const projects = await scanProjects(3); // 3 queries per manual scan
        
        res.json({
            success: true,
            message: `Scanned 3 queries, found ${projects.length} new projects`,
            projects: projects
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

// Auto-scan every 5 minutes (if enabled)
cron.schedule('*/5 * * * *', async () => {
    if (!scanningEnabled) {
        console.log('⏸️ Auto-scan skipped (paused)');
        return;
    }
    
    console.log('⏰ Auto-scan triggered');
    try {
        await scanProjects(5); // 5 queries per auto-scan
    } catch (error) {
        console.error('Auto-scan error:', error);
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
    console.log(`   GET  /api/stats`);
});
