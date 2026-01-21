-- Trakr Database Schema for Supabase

-- Projects table (scanned projects)
CREATE TABLE projects (
    tweet_id TEXT PRIMARY KEY,
    project_handle TEXT NOT NULL,
    tweet_text TEXT NOT NULL,
    tweet_author TEXT,
    tweet_url TEXT NOT NULL,
    project_url TEXT NOT NULL,
    account_created TIMESTAMP,
    followers INTEGER DEFAULT 0,
    verified BOOLEAN DEFAULT FALSE,
    bio TEXT,
    found_by_query TEXT,
    found_at TIMESTAMP DEFAULT NOW()
);

-- Index for faster queries
CREATE INDEX idx_projects_found_at ON projects(found_at DESC);
CREATE INDEX idx_projects_handle ON projects(project_handle);

-- Whale searches table (rate limiting)
CREATE TABLE whale_searches (
    id BIGSERIAL PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    username_searched TEXT NOT NULL,
    results_count INTEGER DEFAULT 0,
    searched_at TIMESTAMP DEFAULT NOW()
);

-- Index for rate limiting queries
CREATE INDEX idx_whale_searches_wallet ON whale_searches(wallet_address, searched_at DESC);

-- View for rate limit checking (optional)
CREATE OR REPLACE VIEW whale_search_daily_counts AS
SELECT 
    wallet_address,
    COUNT(*) as search_count,
    MAX(searched_at) as last_search
FROM whale_searches
WHERE searched_at > NOW() - INTERVAL '24 hours'
GROUP BY wallet_address;
