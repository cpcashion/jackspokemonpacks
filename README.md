# Jack's Pokemon Packs — AI Card Deal Finder

Continuous AI-powered agent that scrapes eBay, Mercari, OfferUp, and Facebook Marketplace for underpriced Pokemon cards.

## Setup

```bash
npm install
cp .env.example .env
# Add your GEMINI_API_KEY to .env
node server.js
```

## Environment Variables

- `GEMINI_API_KEY` — Google Gemini API key (required for Vision AI)
- `PORT` — Server port (default: 3000)
- `SCAN_INTERVAL_MINUTES` — How often to scan (default: 3)
