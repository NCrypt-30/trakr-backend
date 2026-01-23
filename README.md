# Trakr Backend API

Backend service for Trakr Chrome Extension - handles centralized X API scanning and whale tracking.

## Features

- **Auto-scanning**: Scans X API every 5 minutes for pre-launch crypto projects
- **Whale Tracker**: User-triggered searches with rate limiting (10/day per wallet)
- **June 2024 Filter**: Only returns projects created after June 1, 2024
- **Centralized**: One X API key serves all users

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Supabase

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project
3. Go to Settings → API
4. Copy your `URL` and `anon/public` key
5. Go to SQL Editor
6. Run the `schema.sql` file to create tables

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and add:
- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_KEY`: Your Supabase anon key
- `TWITTER_BEARER_TOKEN`: Your X API Bearer token

### 4. Run Server

Development:
```bash
npm run dev
```

Production:
```bash
npm start
```

## API Endpoints

### GET /api/projects
Get latest scanned projects (max 100)

**Response:**
```json
{
  "success": true,
  "count": 25,
  "projects": [...]
}
```

### GET /api/scan
Trigger manual scan (3 queries)

**Response:**
```json
{
  "success": true,
  "message": "Scanned 3 queries, found 5 new projects",
  "projects": [...]
}
```

### POST /api/whale/search
Search user's recent follows

**Request:**
```json
{
  "walletAddress": "7xKX...abc",
  "username": "NCrypt30",
  "limit": 25
}
```

**Response:**
```json
{
  "success": true,
  "searchesRemaining": 7,
  "username": "NCrypt30",
  "totalChecked": 25,
  "accounts": [...]
}
```

**Rate Limited Response (429):**
```json
{
  "success": false,
  "error": "Daily limit reached (10/10). Resets in 6 hours.",
  "searchesRemaining": 0
}
```

### GET /api/stats
Get system statistics

**Response:**
```json
{
  "success": true,
  "stats": {
    "totalProjects": 150,
    "whaleSearchesToday": 45,
    "lastUpdate": "2026-01-21T..."
  }
}
```

### GET /health
Health check endpoint

## Deployment

### Railway (Recommended - Free Tier)

1. Go to [railway.app](https://railway.app)
2. Create new project
3. Connect your GitHub repo
4. Add environment variables
5. Deploy!

### Render

1. Go to [render.com](https://render.com)
2. New → Web Service
3. Connect repo
4. Add environment variables
5. Deploy!

## Cron Schedule

- **Every 5 minutes**: Auto-scan (5 random queries)
- Runs 24/7 automatically

## Cost Estimation

### X API (Pay-as-you-go)
- 5 queries × 12 scans/hour = 60 queries/hour
- 60 × 24 = 1,440 queries/day
- ~50 project lookups/day
- **Total: ~1,500 requests/day = $0.075/day** (~$2.25/month)

### Whale Tracker (User-triggered)
- Depends on usage
- If 100 users × 10 searches/day = 1,000 requests/day = $0.05/day

### Hosting
- Railway/Render free tier: $0
- Supabase free tier: $0

**Total: ~$2-3/month** for backend infrastructure

## Monitoring

Check logs for scan results:
```bash
npm run dev
```

Look for:
- `🔍 Starting scan...`
- `✅ Final: X projects created after June 2024`
- `💾 Saved X projects to database`

## Troubleshooting

**Q: No projects being found?**
- Check X API token is valid
- Verify June 2024 filter isn't too restrictive
- Check search terms are matching recent tweets

**Q: Whale tracker not working?**
- Verify wallet address format
- Check rate limit hasn't been hit
- Ensure username exists on X

**Q: Database errors?**
- Verify Supabase credentials
- Check tables were created (schema.sql)
- Review Supabase logs

## Security Notes

- Never commit `.env` file
- Keep X API token secret
- Supabase anon key is safe to expose (has RLS)
- Consider adding API authentication for production
