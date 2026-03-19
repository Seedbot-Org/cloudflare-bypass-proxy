# Cloudflare Bypass Proxy

A lightweight proxy service that uses [puppeteer-real-browser](https://github.com/zfcsoftware/puppeteer-real-browser) to bypass Cloudflare Turnstile protection, providing a simple REST API.

## Features

- Bypasses Cloudflare Turnstile automatically
- GraphQL endpoint for APIs like Stake
- Built-in Stake bet lookup endpoint
- Optional API key authentication
- Health check endpoints

## Quick Start

### Docker (recommended)

> **Apple Silicon (M1/M2/M3):** add `--platform linux/amd64` to both commands below.

**Build the image:**

```bash
docker build -t cf-proxy .
```

**Run the container:**

```bash
docker run --rm -p 3003:3003 \
  -e PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
  cf-proxy
```

**With optional API key auth:**

```bash
docker run --rm -p 3003:3003 \
  -e PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
  -e API_KEY=your-secret-key \
  cf-proxy
```

The service will be available at `http://localhost:3003`.

> **Note:** The first request will take 10–30 seconds while the browser launches and solves the Cloudflare challenge. Subsequent requests reuse the session and are much faster.

---

### Manual Setup (local development)

```bash
pnpm install
pnpm dev
```

Chrome must be installed locally and `PUPPETEER_EXECUTABLE_PATH` must point to it, or Puppeteer will download its own Chromium.

---

## API Endpoints

### Health Check

```bash
GET /health
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

**Example:**

```bash
curl -X POST http://localhost:3003/api/proxy/stake/bet \
  -H "Content-Type: application/json" \
  -d '{"betId": "house:456499839614"}'
```

---

## Configuration

| Variable                    | Default   | Description                                    |
| --------------------------- | --------- | ---------------------------------------------- |
| `PORT`                      | `3003`    | Server port                                    |
| `PUPPETEER_EXECUTABLE_PATH` | _(auto)_  | Path to Chrome binary                          |
| `CORS_ORIGINS`              | `*`       | Allowed CORS origins (comma-separated)         |
| `REQUEST_TIMEOUT`           | `60000`   | Request timeout in ms                          |
| `API_KEY`                   | _(empty)_ | Optional API key for auth (`x-api-key` header) |

---

## Deploying to Railway

Railway will auto-detect the `Dockerfile` and build it automatically.

**Required environment variables in Railway dashboard:**

| Variable                    | Value                           |
| --------------------------- | ------------------------------- |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/google-chrome-stable` |
| `PORT`                      | `3003`                          |

> Allocate at least **1 GB RAM** to the Railway service — Chrome is memory-heavy.

---

## Usage in seedbot-backend

```typescript
const response = await fetch("http://localhost:3003/api/proxy/stake/bet", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    // "x-api-key": "your-secret-key", // if API_KEY is set
  },
  body: JSON.stringify({ betId: "house:123456789" }),
});

const result = await response.json();
// result.data contains the Stake API response
```
