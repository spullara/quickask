# Text to phonemes for tiny-voca (the on-device voice). Plain CPython keeps the lexicon in memory between requests.
FROM python:3.12-slim
RUN pip install --no-cache-dir numpy
COPY wheels/ /tmp/wheels/
RUN pip install --no-cache-dir /tmp/wheels/*.whl && rm -rf /tmp/wheels
COPY server.py /app/server.py
EXPOSE 8080
CMD ["python", "-u", "/app/server.py"]
