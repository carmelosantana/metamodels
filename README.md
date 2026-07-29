# MetaModels

## Run the stack

```bash
cp .env.example .env   # edit secrets + operator login
docker compose up -d --build
docker compose run --rm control-plane pnpm seed
```

Control-plane UI at http://localhost:3000, data-plane proxy at http://localhost:8787. Full instructions: [docs/DEPLOY.md](docs/DEPLOY.md).
