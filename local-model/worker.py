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


def download_progress(tqdm, report):
    """Keep byte accounting independent of tqdm's disabled/non-TTY counter."""
    class Progress(tqdm):
        def __init__(self, *args, **kwargs):
            self.download_bytes = kwargs.get("initial", 0)
            self.last_report = 0.0
            super().__init__(*args, **kwargs)
            self.report_bytes(force=True)

        def report_bytes(self, force=False):
            now = time.monotonic()
            if force or now - self.last_report >= 0.25:
                self.last_report = now
                report(int(self.download_bytes))

        def update(self, n=1):
            self.download_bytes += n
            result = super().update(n)
            self.report_bytes()
            return result

        def close(self):
            self.report_bytes(force=True)
            return super().close()

    return Progress


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
        return "The local model runtime image has missing or incompatible dependencies. Rebuild the runtime image and retry. " + message
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
        from huggingface_hub import snapshot_download, hf_hub_download
        from huggingface_hub.utils import tqdm

        if "dry_run" not in inspect.signature(snapshot_download).parameters:
            raise ImportError("The installed Hugging Face Hub version is too old; update the local model environment.")
        repo = config["model"]
        repo_root = os.path.join(config["cache"], "models--" + repo.replace("/", "--"))
        marker_path = os.path.join(repo_root, ".mnemonic-ready.json")
        if config.get("mode") == "download":
            phase = "Checking files"
            send(phase=phase)
            repo = config["model"]
            token = config.get("token") or False
            common = dict(repo_id=repo, cache_dir=config["cache"], token=token)
            # Select one weight format; never download duplicate PyTorch/TF/GGUF copies.
            patterns = ["*.json", "*.jinja", "*.txt", "*.model", "*.tiktoken", "*.safetensors"]
            files = snapshot_download(**common, allow_patterns=patterns, dry_run=True)
            if not any(f.filename.endswith(".safetensors") for f in files):
                raise ValueError("This runtime needs Transformers safetensors weights. GGUF, adapter-only, and other unsupported repositories need a compatible model repository.")
            total = sum(f.file_size for f in files)
            completed = sum(f.file_size for f in files if not f.will_download)
            phase = "Downloading"
            send(phase=phase, downloaded=completed, total=total)

            snapshot = None
            for info in files:
                # Capture each file's offset; resumed HTTP transfers include their initial bytes.
                offset, file_size = completed, info.file_size if info.will_download else 0
                Progress = download_progress(tqdm, lambda count, offset=offset, file_size=file_size:
                    send(phase="Downloading", downloaded=offset + min(file_size, max(0, count)), total=total))
                filename = hf_hub_download(**common, revision=info.commit_hash, filename=info.filename, tqdm_class=Progress)
                if info.will_download:
                    completed += info.file_size
                send(phase=phase, downloaded=completed, total=total)
                if info.filename == "config.json":
                    snapshot = os.path.dirname(filename)
            if snapshot is None:
                raise ValueError("Repository has no model config.json.")

            revision = next(info.commit_hash for info in files if info.filename == "config.json")
            with open(marker_path + ".tmp", "w") as marker:
                json.dump({"model": repo, "revision": revision, "files": [{"name": f.filename, "size": f.file_size} for f in files]}, marker)
            os.replace(marker_path + ".tmp", marker_path)
            send(phase="Ready")
            # Parent confirms completion and removes the download container.
            sys.stdin.read()
            return
        else:
            try:
                with open(marker_path) as marker:
                    manifest = json.load(marker)
                snapshot = os.path.join(repo_root, "snapshots", manifest["revision"])
                if manifest["model"] != repo or not all(os.path.getsize(os.path.join(snapshot, f["name"])) == f["size"] for f in manifest["files"]):
                    raise ValueError("Incomplete cache")
            except (OSError, KeyError, ValueError):
                raise ValueError("Download this model in Settings > Hugging Face before running the node.")
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        phase = "Loading"
        send(phase=phase)
        tokenizer = AutoTokenizer.from_pretrained(snapshot, local_files_only=True, trust_remote_code=False)
        if not tokenizer.chat_template:
            raise ValueError("This model has no chat template. Select a chat/instruction model with a tokenizer chat template.")
        if config.get("useGpu") and not torch.cuda.is_available():
            raise RuntimeError("GPU was requested but CUDA is unavailable in the container. Check Docker GPU support or turn off Use GPU in Settings.")
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
