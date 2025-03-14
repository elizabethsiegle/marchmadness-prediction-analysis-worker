# NCAA Basketball Stats & Analysis App

A Cloudflare Workers application that provides NCAA basketball statistics (from the NCAA website--not with scores of games being played, but only once they are finished) and AI-powered analysis for both men's and women's Division I teams.

YouTube video: https://www.youtube.com/watch?v=OTvfjudifDg&t=28s

## Features

- Statistics from NCAA.com (using [this NCAA API](https://github.com/henrygd/ncaa-api))
- Support for both men's and women's Division I basketball
- AI-powered analysis of team performance
- Interactive web interface
- Data caching for improved performance
- Data visualizations based on conference and team standings from NCAA.com

## Tech Stack

- Cloudflare Workers
- Cloudflare D1 (SQLite)
- Cloudflare Workers AI
- Cloudflare KV for caching
- NCAA API integration

## Setup

1. Install Wrangler CLI:
```bash
npm install -g wrangler
```

2. Clone the repository:
```bash
git clone https://github.com/elizabethsiegle/marchmadness-prediction-analysis-worker
cd https://github.com/elizabethsiegle/marchmadness-prediction-analysis-worker
```

3. Create D1 databases:
```bash
wrangler d1 create basketball-women
wrangler d1 create basketball-men
```

4. Initialize both databases using the schema:
```bash
wrangler d1 execute basketball-women --file=./schema.sql
wrangler d1 execute basketball-men --file=./schema.sql
```

5. Configure environment variables in `wrangler.jsonc`:
```json
"kv_namespaces": [
    {
      "binding": "BROWSER_KV_MM",
      "id": "your-kv-id-here",
      "preview_id": "your-preview-id-here"
    }
  ],
  "ai": {
    "binding": "AI"
  },
  "d1_databases": [
    {
      "binding": "DB_MEN",
      "database_name": "FOR-EX-MARCH-MADNESS-MEN",
      "database_id": "YOUR-DB-ID-HERE"
    },
    {
      "binding": "DB",
      "database_name": "FOR-EX-MARCH-MADNESS-WOMEN",
      "database_id": "YOUR-DB-ID-HERE"
    }
  ]
```

6. Deploy:
```bash
wrangler deploy
```
