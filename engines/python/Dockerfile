# Python Tetris Engine — Production image (FastAPI + Uvicorn)
FROM python:3.12-slim

WORKDIR /app

# Copy source into a Python package structure so uvicorn can find it
COPY src/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY src/main.py .
COPY src/game.py .

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
