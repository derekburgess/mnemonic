"""One node's model lifetime. JSON lines on stdout; library logs on stderr."""
import json
import os
import sys
import time
import traceback
import uuid
import threading
import inspect

protocol = sys.stdout
sys.stdout = sys.stderr


def send(**payload):
    protocol.write(json.dumps(payload) + "\n")
    protocol.flush()


def describe_error(error, phase):
    message = str(error)
    low = message.lower()
    if "out of memory" in low and ("cuda" in low or "mps" in low):
        return "GPU out of memory. Choose a smaller model or free GPU memory. " + message
    if isinstance(error, MemoryError) or "cannot allocate memory" in low or "not enough memory" in low:
        return "Insufficient RAM to run this model. Choose a smaller model or free system memory. " + message
    if "no space left" in low:
        return "Model download failed: insufficient disk space. Free space in the model cache. " + message
    if isinstance(error, ImportError):
        return "Local model dependencies are missing. Run npm run setup:local-model. " + message
    return phase + " failed: " + message


def main():
    parent = os.getppid()
    def watch_parent():
        while True:
            time.sleep(1)
            if os.getppid() != parent:
                os._exit(1)
    threading.Thread(target=watch_parent, daemon=True).start()
    phase = "Preparing"
    try:
        config = json.loads(sys.stdin.readline())
        send(phase=phase)
        # Do not fork workers that could survive this process and retain model memory.
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from huggingface_hub import snapshot_download, hf_hub_download
        from huggingface_hub.utils import tqdm

        if "dry_run" not in inspect.signature(snapshot_download).parameters:
            raise ImportError("The installed Hugging Face Hub version is too old; update the local model environment.")
        phase = "Downloading"
        send(phase=phase)
        repo = config["model"]
        token = config.get("token") or False
        common = dict(repo_id=repo, cache_dir=config["cache"], token=token)
        # Select one weight format; never download duplicate PyTorch/TF/GGUF copies.
        patterns = ["*.json", "*.jinja", "*.txt", "*.model", "*.tiktoken", "*.safetensors"]
        files = snapshot_download(**common, allow_patterns=patterns, dry_run=True)
        if not any(f.filename.endswith(".safetensors") for f in files):
            raise ValueError("This runtime needs Transformers safetensors weights. GGUF, adapter-only, and other unsupported repositories need a compatible model repository.")
        total = sum(f.file_size for f in files if f.will_download)
        completed = 0
        last = 0.0

        class Progress(tqdm):
            def update(self, n=1):
                nonlocal last
                result = super().update(n)
                now = time.monotonic()
                if now - last > 0.25:
                    last = now
                    send(phase="Downloading", downloaded=min(total, completed + int(self.n)), total=total)
                return result

        snapshot = None
        for info in files:
            filename = hf_hub_download(**common, revision=info.commit_hash, filename=info.filename, tqdm_class=Progress)
            if info.will_download:
                completed += info.file_size
            send(phase=phase, downloaded=completed, total=total)
            if info.filename == "config.json":
                snapshot = os.path.dirname(filename)
        if snapshot is None:
            raise ValueError("Repository has no model config.json.")

        phase = "Loading"
        send(phase=phase)
        tokenizer = AutoTokenizer.from_pretrained(snapshot, local_files_only=True, trust_remote_code=False)
        if not tokenizer.chat_template:
            raise ValueError("This model has no chat template. Select a chat/instruction model with a tokenizer chat template.")
        device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
        model = AutoModelForCausalLM.from_pretrained(snapshot, local_files_only=True, trust_remote_code=False,
                                                   use_safetensors=True, dtype="auto", device_map=device)
        model.eval()
        def resources():
            metrics = {"device": device}
            try:
                import resource
                metrics["peakMemoryBytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)
            except ImportError:
                pass
            if device == "cuda":
                metrics["peakGpuMemoryBytes"] = torch.cuda.max_memory_allocated()
            return metrics
        send(phase="Ready", resources=resources())
        for line in sys.stdin:
            request = json.loads(line)
            phase = "Inference"
            try:
                body = request["body"]
                messages = body["messages"]
                for message in messages:
                    if isinstance(message.get("content"), list):
                        if any(p.get("type") != "text" for p in message["content"]):
                            raise ValueError("This local runtime supports text inputs only; remove image/PDF attachments or use a compatible remote endpoint.")
                        message["content"] = "\n".join(p["text"] for p in message["content"])
                    for call in message.get("tool_calls", []):
                        args = call["function"].get("arguments")
                        if isinstance(args, str):
                            call["function"]["arguments"] = json.loads(args)
                tools = body.get("tools")
                if tools and not getattr(tokenizer, "response_template", None):
                    raise ValueError("This model has no Transformers tool-response parser. Remove tools from this node or select a model with a response template supporting tools.")
                inputs = tokenizer.apply_chat_template(messages, tools=tools, add_generation_prompt=True,
                                                       return_dict=True, return_tensors="pt").to(model.device)
                input_count = inputs["input_ids"].shape[-1]
                limit = int(body.get("max_tokens") or 1024)
                context = getattr(model.config, "max_position_embeddings", None)
                if isinstance(context, int):
                    limit = min(limit, context - input_count)
                if limit <= 0:
                    raise ValueError("Input exceeds this model's context window. Shorten the node input.")
                with torch.inference_mode():
                    output = model.generate(**inputs, max_new_tokens=limit, do_sample=False,
                                            pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id)
                generated = output[0, input_count:]
                if getattr(tokenizer, "response_template", None):
                    message = tokenizer.parse_response(generated, prefix=inputs["input_ids"][0], tools=tools)
                else:
                    message = {"role": "assistant", "content": tokenizer.decode(generated, skip_special_tokens=True)}
                for call in message.get("tool_calls", []):
                    call.setdefault("id", "call_" + uuid.uuid4().hex)
                    call.setdefault("type", "function")
                    args = call["function"].get("arguments", {})
                    if not isinstance(args, str):
                        call["function"]["arguments"] = json.dumps(args)
                send(phase="Running", resources=resources())
                send(id=request["id"], result={"id": "local_" + uuid.uuid4().hex, "object": "chat.completion",
                     "created": int(time.time()), "model": repo,
                     "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if message.get("tool_calls") else "length" if len(generated) >= limit else "stop"}],
                     "usage": {"prompt_tokens": input_count, "completion_tokens": len(generated), "total_tokens": input_count + len(generated)}})
                del inputs, output, generated
            except Exception as error:
                send(id=request["id"], error=describe_error(error, phase))
                traceback.print_exc(file=sys.stderr)
                # Parent tears down the worker, including after a failed generation.
                break
    except Exception as error:
        send(error=describe_error(error, phase))
        traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
