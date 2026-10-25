# tagged: webapp + API + the Chrome extension zip, in one image.
# The InsightFace models (non-commercial research licence) are NOT baked in: they download into /data/models on first start.
FROM python:3.12-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.5.0 /uv /usr/local/bin/uv
WORKDIR /src
COPY backend/pyproject.toml backend/uv.lock ./backend/
COPY backend/tagged ./backend/tagged
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_COMPILE_BYTECODE=1
RUN cd backend && uv sync --frozen --no-dev --no-editable

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 tagged && mkdir /data && chown tagged /data
COPY --from=build /opt/venv /opt/venv
COPY extension /app/extension
ENV PATH=/opt/venv/bin:$PATH \
    TAGGED_EXTENSION_DIR=/app/extension \
    INSIGHTFACE_HOME=/data/models \
    PYTHONUNBUFFERED=1
USER tagged
WORKDIR /data
VOLUME /data
EXPOSE 8768
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s \
  CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8768/api/ping', timeout=3)"
# the people (private embeddings) are never on the server: the browser keeps them
CMD ["tagged", "serve", "--host", "0.0.0.0", "--port", "8768"]
