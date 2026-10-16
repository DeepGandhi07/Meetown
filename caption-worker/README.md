# Meetown self-hosted caption worker

This service performs speech recognition with faster-whisper and translation with locally installed Argos Translate packages. It does not call a commercial speech or translation API and does not persist audio. Model inference is resource-intensive; CPU-only setups may have several seconds of latency.

## Setup

Use Python 3.10–3.12 in a virtual environment:

```bash
python -m venv .venv
# Windows PowerShell: .venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8010
```

The first faster-whisper model load downloads model weights unless they are already cached. This is a one-time model download, not an external API call. For a fully offline deployment, pre-populate the model cache and install the required Argos `.argosmodel` language packages before disconnecting from the internet. Install only the source/target pairs you need. For example, German↔English, run `python install_argos_pairs.py de-en en-de`. This helper downloads open-source model packages during setup; runtime translation remains local. For a fully offline deployment, transfer and install `.argosmodel` packages manually.

Set `WHISPER_MODEL=tiny` for a faster, less accurate CPU test or `base` for a better baseline. GPU deployment needs a compatible CUDA/cuDNN environment and `WHISPER_DEVICE=cuda`.

## API

- `GET /health` — worker health.
- `POST /transcribe?language=auto` — raw little-endian mono signed-16-bit PCM at 16 kHz; returns transcript and detected language.
- `POST /translate` — JSON `{ "text": "...", "source_language": "de", "target_language": "en" }`; returns translated text when that Argos pair is installed.

Audio is held in memory for the request and not written to disk. Secure this service behind localhost/private networking; do not expose it publicly without authentication and request limits.
