FROM python:3.12-slim
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
WORKDIR /app
RUN pip install --no-cache-dir torch==2.7.1 --index-url ${TORCH_INDEX}
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN python -c "from transformers import AutoModelForCausalLM, AutoTokenizer"
COPY worker.py .
ENV HF_HUB_DISABLE_TELEMETRY=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1 HOME=/tmp
ENTRYPOINT ["python", "-u", "/app/worker.py"]
