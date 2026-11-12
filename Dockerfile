FROM python:3.12-slim

WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt \
    # download the recognition models into the image so the first scan is fast
    && homr --init

COPY server server
COPY web web

ENV PORT=7860
EXPOSE 7860
CMD ["sh", "-c", "uvicorn server.app:app --host 0.0.0.0 --port ${PORT}"]
