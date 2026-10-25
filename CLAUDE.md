# tagged

See SPEC.md for the design. Personal tool: face-based triage of event photos for Miguel + ~15 friends.

## Layout
- `backend/` Python (uv). `uv run tagged --help`.
- `extension/` Chrome MV3 bridge (Facebook tab <-> webapp). Webapp is `backend/tagged/web/` (index.html, app.js, built app.css, vendored fflate.js), served by `tagged serve`.
- `web/` only builds `app.css` (Tailwind + daisyUI): `npm run build` after changing classes. No CDNs: the page has a strict CSP.
- `Dockerfile`, `docker-compose.yml`, `.github/workflows/docker.yml`: image `ghcr.io/mpoboas/tagged`. Only the models live in the /data volume, never in the image; people never reach the server (they stay in the browser).

## Conventions
- Python 3.12 (3.10-3.12 supported), uv, no heavy frameworks; keep the CLI usable without the server.
- Real photos/embeddings are private: `data/` is gitignored, never commit images.
- Thresholds (and the min face size/detection score) live in `backend/tagged/triage.py`; calibrate with `tagged eval` (shrinks test photos to thumbnail size).
- Tests: `uv run pytest`, lint: `uv run ruff check .` (run in CI before the image is built).
