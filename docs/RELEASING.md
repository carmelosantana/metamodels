# Releasing MetaModels

Images publish automatically from `.github/workflows/release.yml`.

- **Every push to `main`** → `…:edge` (for test deploys between releases).
- **A pushed tag `vX.Y.Z`** → `…:X.Y.Z`, `…:X.Y`, and `…:latest`.

## Cut a release

1. Ensure `main` is green (CI) and the lock-down reviews are clean.
2. Tag and push:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. Watch the `release` workflow publish both images to GHCR.
4. In Portainer, set the stack's `TAG=v0.1.0` and redeploy to pull it.

The first release is **v0.1.0** — pre-1.0 while the API and schema may still move.
