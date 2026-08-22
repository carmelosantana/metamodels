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
4. **Verify the build-provenance attestations before deploying** (the release workflow signs
   both images keylessly; nothing downstream trusts them unless you check):
   ```bash
   gh attestation verify oci://ghcr.io/carmelosantana/metamodels-control-plane:0.1.0 --owner carmelosantana
   gh attestation verify oci://ghcr.io/carmelosantana/metamodels-runtime:0.1.0 --owner carmelosantana
   ```
   Record the resolved image digest each command prints and deploy **that digest** (pin
   `image: …@sha256:…`), so the artifact you verified is the one that runs.
5. In Portainer, set the stack's `TAG=0.1.0` (the image tag drops the `v`) and redeploy to pull it.

The first release is **v0.1.0** — pre-1.0 while the API and schema may still move.
