# MetaModels

Self-hosted governance and monetization for local AI. MetaModels puts authentication, API keys, rate limits, per-provider constraints, and usage metering in front of an otherwise unprotected Ollama or ComfyUI server, so you can safely expose one to other people — or bill for it.

## Run the stack

```bash
cp .env.example .env   # edit secrets + operator login
docker compose up -d --build
docker compose run --rm control-plane pnpm seed
```

Control-plane UI at http://localhost:3000, data-plane proxy at http://localhost:8787 — set `CONTROL_PLANE_PORT` / `DATA_PLANE_PORT` in `.env` if either is already taken. Full instructions: [docs/DEPLOY.md](docs/DEPLOY.md).
