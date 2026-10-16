"""Self-hosted speech-to-text and text translation worker for Meetown.

Accepts short 16 kHz mono signed-16-bit PCM chunks. No audio is persisted.
Install Argos Translate language packages locally for the language pairs you need.
"""
import io
import os
import threading
from functools import lru_cache

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from faster_whisper import WhisperModel
from pydantic import BaseModel, Field
import argostranslate.translate

MODEL_SIZE = os.getenv("WHISPER_MODEL", "base")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
MAX_AUDIO_BYTES = int(os.getenv("MAX_AUDIO_BYTES", "256000"))

app = FastAPI(title="Meetown Caption Worker", version="0.1.0")
model_lock = threading.Lock()

@lru_cache(maxsize=1)
def get_model():
    return WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)

class TranslateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    source_language: str = Field(min_length=2, max_length=5)
    target_language: str = Field(min_length=2, max_length=5)

@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_SIZE, "device": DEVICE}

@app.post("/transcribe")
async def transcribe(request: Request, language: str = "auto"):
    raw = await request.body()
    if not raw or len(raw) > MAX_AUDIO_BYTES or len(raw) % 2:
        raise HTTPException(400, "Expected a non-empty 16-bit PCM audio chunk within size limits")
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if samples.size < 8000:
        raise HTTPException(400, "Audio chunk is too short")
    requested = None if language == "auto" else language
    try:
        with model_lock:
            segments, info = get_model().transcribe(
                samples,
                language=requested,
                vad_filter=True,
                beam_size=1,
                condition_on_previous_text=False,
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
        return {"text": text, "language": info.language or requested or "und", "language_probability": info.language_probability}
    except Exception as exc:
        raise HTTPException(500, f"Transcription failed: {type(exc).__name__}") from exc

@app.post("/translate")
def translate(payload: TranslateRequest):
    if payload.source_language == payload.target_language:
        return {"text": payload.text, "translated": False}
    try:
        languages = argostranslate.translate.get_installed_languages()
        source = next((lang for lang in languages if lang.code == payload.source_language), None)
        target = next((lang for lang in languages if lang.code == payload.target_language), None)
        if not source or not target:
            raise HTTPException(424, f"Translation language package not installed: {payload.source_language}->{payload.target_language}")
        translation = source.get_translation(target)
        if translation is None:
            raise HTTPException(424, f"Translation pair not installed: {payload.source_language}->{payload.target_language}")
        return {"text": translation.translate(payload.text), "translated": True}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Translation failed: {type(exc).__name__}") from exc
