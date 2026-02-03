// TRAKR BACKEND - FIXED VERSION
// Deploy this to replace your current backend

const express = require('express');
const cors = require('cors');
// Native fetch is built into Node.js 18+ - no import needed!

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for extension
app.use(cors());
app.use(express.json());

// ============================================================================
// PUMP.FUN API INTEGRATION
// ============================================================================

const PUMP_FUN_API = 'https://frontend-api.pump.fun/coins/graduating-soon';

async function fetchFromPumpFun() {
    try {
        console.log('📡 Fetching graduations from Pump.fun...');
        
        const response = await fetch(PUMP_FUN_API, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Trakr/1.0'
            }
        });

        if (!response.ok) {
            throw new Error(`Pump.fun API returned ${response.status}`);
        }

        const data = await response.json();
        
        // Transform Pump.fun data to our format
        const tokens = data.map(token => ({
            contract: token.mint,
            symbol: token.symbol || token.name,
            name: token.name,
            price: token.usd_market_cap ? (token.usd_market_cap / 1000000000).toString() : '0',
            graduatedAt: new Date(token.created_timestamp).toISOString(),
            liquidity: token.usd_market_cap || 0,
            marketCap: token.usd_market_cap || 0,
            hasLogo: !!token.image_uri,
            hasWebsite: !!token.website,
            hasSocials: !!(token.twitter || token.telegram),
            logoUrl: token.image_uri || null,
            websiteUrl: token.website || null,
            twitterUrl: token.twitter || null,
            telegramUrl: token.telegram || null,
            description: token.description || null
        }));

        return tokens;
        
    } catch (error) {
        console.error('❌ Error fetching from Pump.fun:', error.message);
        throw error;
    }
}

// ============================================================================
// MAIN API ENDPOINT - FIXED VERSION
// ============================================================================

app.get('/api/live-launches', async (req, res) => {
    try {
        const startTime = Date.now();
        
        // 1. Fetch all graduations from Pump.fun
        const allGraduations = await fetchFromPumpFun();
        console.log(`📥 Fetched ${allGraduations.length} graduations from Pump.fun`);

        // 2. Filter by age ONLY (keep last 60 minutes)
        // NO GLOBAL DEDUP! Each client deduplicates for itself.
        const now = Date.now();
        const MAX_AGE_MS = 60 * 60 * 1000; // 60 minutes
        
        const recentTokens = allGraduations.filter(token => {
            const graduatedAt = new Date(token.graduatedAt).getTime();
            const age = now - graduatedAt;
            return age < MAX_AGE_MS;
        });

        const oldCount = allGraduations.length - recentTokens.length;
        
        // Log summary (not each skip!)
        console.log(`✅ Filtered to ${recentTokens.length} recent graduations (<60 min)`);
        if (oldCount > 0) {
            console.log(`   Skipped ${oldCount} old graduations (>60 min)`);
        }

        // 3. Sort by newest first
        recentTokens.sort((a, b) => {
            const timeA = new Date(a.graduatedAt).getTime();
            const timeB = new Date(b.graduatedAt).getTime();
            return timeB - timeA; // Newest first
        });

        // 4. Send to ALL clients (stateless!)
        const responseTime = Date.now() - startTime;
        console.log(`✅ Response sent in ${responseTime}ms`);
        
        res.json({
            success: true,
            launches: recentTokens,
            totalScanned: allGraduations.length,
            recentCount: recentTokens.length,
            timestamp: now,
            responseTime: responseTime
        });

    } catch (error) {
        console.error('❌ Error in /api/live-launches:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            launches: [],
            totalScanned: 0
        });
    }
});

// ============================================================================
// OPTIONAL: CACHING (Reduces Pump.fun API calls)
// ============================================================================

let cache = {
    data: null,
    timestamp: 0
};
const CACHE_TTL = 30 * 1000; // 30 seconds

app.get('/api/live-launches-cached', async (req, res) => {
    try {
        const now = Date.now();
        
        // Check cache
        if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
            console.log('✅ Serving cached data');
            return res.json({
                ...cache.data,
                cached: true,
                cacheAge: Math.floor((now - cache.timestamp) / 1000)
            });
        }

        // Fetch fresh data
        const startTime = Date.now();
        const allGraduations = await fetchFromPumpFun();
        
        // Filter by age
        const MAX_AGE_MS = 60 * 60 * 1000;
        const recentTokens = allGraduations.filter(token => {
            const age = now - new Date(token.graduatedAt).getTime();
            return age < MAX_AGE_MS;
        });

        // Sort newest first
        recentTokens.sort((a, b) => 
            new Date(b.graduatedAt) - new Date(a.graduatedAt)
        );

        // Update cache
        cache = {
            data: {
                success: true,
                launches: recentTokens,
                totalScanned: allGraduations.length,
                recentCount: recentTokens.length,
                timestamp: now,
                responseTime: Date.now() - startTime
            },
            timestamp: now
        };

        console.log(`✅ Fresh data cached (${recentTokens.length} graduations)`);

        res.json({
            ...cache.data,
            cached: false
        });

    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: Date.now(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cache: {
            hasData: !!cache.data,
            age: cache.timestamp ? Math.floor((Date.now() - cache.timestamp) / 1000) : null
        }
    });
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════');
    console.log(`🚀 Trakr Backend STARTED`);
    console.log(`📍 Port: ${PORT}`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log('═══════════════════════════════════════════════════');
    console.log('✅ Endpoints:');
    console.log('   GET /api/live-launches');
    console.log('   GET /api/live-launches-cached (with 30s cache)');
    console.log('   GET /health');
    console.log('═══════════════════════════════════════════════════');
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

process.on('SIGTERM', () => {
    console.log('⏸️ SIGTERM received, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('⏸️ SIGINT received, shutting down gracefully...');
    process.exit(0);
});
