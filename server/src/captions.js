import { config } from "./config.js";

export const LANGUAGE_CODES = {
  English: "en",
  German: "de",
  Hindi: "hi",
  French: "fr",
  Spanish: "es",
  Portuguese: "pt",
  Japanese: "ja",
};
const CODE_TO_NAME = Object.fromEntries(
  Object.entries(LANGUAGE_CODES).map(([name, code]) => [code, name]),
);
export const languageName = (code) => CODE_TO_NAME[code] || code;

/** Stops hammering a provider that keeps failing, so captions never block a meeting. */
class CircuitBreaker {
  constructor(name, { threshold = 3, cooldownMs = 30000 } = {}) {
    Object.assign(this, { name, threshold, cooldownMs, failures: 0, openUntil: 0 });
  }
  get open() {
    return Date.now() < this.openUntil;
  }
  success() {
    this.failures = 0;
    this.openUntil = 0;
  }
  failure() {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openUntil = Date.now() + this.cooldownMs;
      this.failures = 0;
    }
  }
  snapshot() {
    return { open: this.open, retryInMs: Math.max(0, this.openUntil - Date.now()) };
  }
}

const breakers = {
  deepgram: new CircuitBreaker("deepgram"),
  worker: new CircuitBreaker("worker"),
  translate: new CircuitBreaker("translate"),
};

export class CaptionUnavailableError extends Error {}

function providerOrder() {
  const { provider, deepgramKey } = config.captions;
  if (provider === "off") return [];
  if (provider === "local") return ["worker"];
  if (provider === "deepgram") return deepgramKey ? ["deepgram"] : [];
  return deepgramKey ? ["deepgram", "worker"] : ["worker"]; // hybrid
}

export function captionsAvailable() {
  return providerOrder().some((name) => !breakers[name].open);
}

async function viaDeepgram(audio, languageCode) {
  const params = new URLSearchParams({
    model: config.captions.deepgramModel,
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    smart_format: "true",
  });
  if (languageCode === "auto") params.set("detect_language", "true");
  else params.set("language", languageCode);
  const response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      authorization: `Token ${config.captions.deepgramKey}`,
      "content-type": "application/octet-stream",
    },
    body: audio,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Deepgram HTTP ${response.status}`);
  const json = await response.json();
  const channel = json.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];
  return {
    text: String(alt?.transcript || "").trim(),
    language: channel?.detected_language || (languageCode === "auto" ? "und" : languageCode),
  };
}

async function viaWorker(audio, languageCode) {
  const response = await fetch(
    `${config.captions.workerUrl}/transcribe?language=${encodeURIComponent(languageCode)}`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: audio,
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) throw new Error(`Caption worker HTTP ${response.status}`);
  const json = await response.json();
  return {
    text: String(json.text || "").trim(),
    language: json.language || (languageCode === "auto" ? "und" : languageCode),
  };
}

const transcribers = { deepgram: viaDeepgram, worker: viaWorker };

/** Returns { text, language, provider }. Throws CaptionUnavailableError if every provider is down. */
export async function transcribe(audio, languageCode) {
  const order = providerOrder();
  if (!order.length) {
    throw new CaptionUnavailableError("No speech provider is configured on the server.");
  }
  for (const name of order) {
    if (breakers[name].open) continue;
    try {
      const result = await transcribers[name](audio, languageCode);
      breakers[name].success();
      return { ...result, provider: name };
    } catch (error) {
      breakers[name].failure();
      console.warn(`[captions] ${name} failed: ${error.message}`);
    }
  }
  throw new CaptionUnavailableError("Speech recognition is temporarily unavailable.");
}

const cache = new Map();
const CACHE_LIMIT = 500;

/** Translates once per (text, pair). Returns "" when translation is unavailable. */
export async function translate(text, sourceCode, targetCode) {
  if (sourceCode === targetCode) return text;
  if (sourceCode === "und" || breakers.translate.open) return "";
  const key = `${sourceCode}>${targetCode}:${text}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const response = await fetch(`${config.captions.workerUrl}/translate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, source_language: sourceCode, target_language: targetCode }),
      signal: AbortSignal.timeout(8000),
    });
    // 424 = language pack not installed: a config issue, not an outage.
    if (response.status === 424) return "";
    if (!response.ok) throw new Error(`Translate HTTP ${response.status}`);
    const translated = String((await response.json()).text || "").slice(0, 2000);
    breakers.translate.success();
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, translated);
    return translated;
  } catch (error) {
    breakers.translate.failure();
    console.warn(`[captions] translate failed: ${error.message}`);
    return "";
  }
}

export function captionHealth() {
  return Object.fromEntries(
    Object.entries(breakers).map(([name, b]) => [name, b.snapshot()]),
  );
}
