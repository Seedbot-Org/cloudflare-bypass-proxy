# Cloudflare Bypass Proxy

A lightweight proxy service that uses Puppeteer with stealth mode to bypass Cloudflare protection, providing a simple REST API.

## Features

- Simple REST API for proxying requests through FlareSolverr
- GraphQL endpoint for APIs like Stake
- Built-in Stake bet lookup endpoint
- Optional API key authentication
- Health check endpoints
- Docker support

## Quick Start

### Using Docker Compose (Recommended)

```bash
# Start both FlareSolverr and the proxy
docker-compose up -d

# Check logs
docker-compose logs -f
```

### Manual Setup

1. Start FlareSolverr:
```bash
docker run -d --name flaresolverr -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest
```

2. Install dependencies and run the proxy:
```bash
pnpm install
pnpm dev
```

## API Endpoints

### Health Check

```bash
GET /health
GET /health/flaresolverr
```

### Generic Proxy

```bash
POST /api/proxy
Content-Type: application/json

{
  "url": "https://example.com",
  "method": "GET",
  "headers": {},
  "body": {},
  "timeout": 60000
}
```

### GraphQL Proxy

```bash
POST /api/proxy/graphql
Content-Type: application/json

{
  "url": "https://stake.ac/_api/graphql",
  "query": "query { ... }",
  "variables": {},
  "operationName": "MyQuery"
}
```

### Stake Bet Lookup

```bash
POST /api/proxy/stake/bet
Content-Type: application/json

{
  "betId": "house:123456789"
}
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3002 | Server port |
| `FLARESOLVERR_URL` | http://localhost:8191/v1 | FlareSolverr endpoint |
| `CORS_ORIGINS` | * | Allowed CORS origins (comma-separated) |
| `REQUEST_TIMEOUT` | 60000 | Request timeout in ms |
| `MAX_TIMEOUT` | 120000 | Max timeout in ms |
| `API_KEY` | (empty) | Optional API key for auth |

## Usage in seedbot-backend

Update your `StakeVerifier` to call this proxy instead of ScraperAPI:

```typescript
const response = await fetch('http://localhost:3002/api/proxy/stake/bet', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    // 'x-api-key': 'your-api-key', // If API_KEY is set
  },
  body: JSON.stringify({ betId: 'house:123456789' }),
});

const result = await response.json();
// result.data contains the Stake API response
```