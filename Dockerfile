FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# curl is required by fetch_frames.py to download frame packs and card fonts
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Fetch frames and fonts first so this ~170 MB layer stays cached across code changes
COPY fetch_frames.py ./
COPY frames/README.md ./frames/README.md
RUN python fetch_frames.py

# Copy application code and static assets
COPY public/ ./public/
COPY server.py pyproject.toml README.md ./

# Create persistent data directories
RUN mkdir -p /app/decks /app/cache

EXPOSE 8765

CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8765", "--no-browser"]
