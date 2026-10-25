# tagged — spec

Sort event photos from Facebook albums: recognise a known set of people, choose which photos to keep, and download them as a zip of originals (or add them to a Google Photos album).

## Parts
1. **backend/** — one stdlib HTTP server (`tagged serve`). It serves the webapp and the extension zip, and `POST /api/score` runs InsightFace (SCRFD detection + ArcFace embeddings; onnxruntime uses CoreML on a Mac, CPU elsewhere) and returns each usable face's box and 512-d embedding. It knows nobody and stores nothing. Optional password: `TAGGED_PASSWORD`.
2. **backend/tagged/web/** — the webapp. Sessions (one per collection) and the people to recognise live in the browser (IndexedDB); matching runs there. Review, per-photo selection, then a zip named `<session>_0001.jpg…` with the upload date written as EXIF, or an upload to Google Photos.
3. **extension/** — Chrome MV3 bridge between an open Facebook album and the webapp (`postMessage`, only on pages carrying the app's marker). It scrolls the album, collects thumbnails, opens each selected photo in the viewer to read the 2048 px original, and takes the upload date from the CDN's `Last-Modified`. Facebook's API is not used (it needs App Review).
4. **CLI** — `cluster`, `label`, `export`, `people-pack` build the people file from photos; `eval` and `match` calibrate the thresholds.

## Triage
Cosine similarity of ArcFace embeddings against each person's reference embeddings (max over refs).
- `>= certain` → **certeza**
- `>= review` → **rever**
- else → **sem match**

Each person is matched to at most one face per photo. Faces under 20 px or with detection score < 0.6 are dropped. Thresholds (certain 0.50, review 0.35) and the face filter live in `backend/tagged/triage.py`; calibrate on real photos with `tagged eval`.

## Constraints
- Starts only on a click, only on the album the user has open, no stored credentials, paced requests.
- Google Photos: since 31 Mar 2025 the API only adds to albums the app itself created (append-only scope).
- The InsightFace models are licensed for non-commercial research: they are not baked into the Docker image, they download on first run.
- Face embeddings are biometric data: never on the server, never in git (`data/` is ignored).
