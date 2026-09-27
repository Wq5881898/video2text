FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    VIDEO2TEXT_CONFIG_DIR=/config

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY deploy/nas/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY apps/nas_worker apps/nas_worker
COPY packages packages
COPY outputs/work/*.py outputs/work/

RUN useradd --create-home --uid 1000 video2text
USER video2text

EXPOSE 8080
CMD ["gunicorn", "--bind=0.0.0.0:8080", "--workers=1", "--threads=4", "--timeout=900", "--graceful-timeout=30", "--access-logfile=-", "--error-logfile=-", "apps.nas_worker.wsgi:app"]
