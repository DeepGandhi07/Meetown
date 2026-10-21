import "dotenv/config";

const list = (value, fallback = "") =>
  (value ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);

const isProduction = process.env.NODE_ENV === "production";

export const config = {
  isProduction,
  port: Number(process.env.PORT || 3003),
  clientOrigins: list(
    process.env.CLIENT_ORIGINS,
    "http://localhost:5173,https://localhost:5173",
  ),
  allowLanOrigins:
    !isProduction && process.env.ALLOW_LAN_ORIGINS !== "false",
  livekit: {
    url: process.env.LIVEKIT_URL || "",
    apiKey: process.env.LIVEKIT_API_KEY || "",
    apiSecret: process.env.LIVEKIT_API_SECRET || "",
  },
  supabase: {
    url: (process.env.SUPABASE_URL || "").replace(/\/$/, ""),
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  },
  captions: {
    provider: (process.env.CAPTION_PROVIDER || "hybrid").toLowerCase(),
    deepgramKey: process.env.DEEPGRAM_API_KEY || "",
    deepgramModel: process.env.DEEPGRAM_MODEL || "nova-3",
    workerUrl: process.env.CAPTION_WORKER_URL || "http://127.0.0.1:8010",
    maxChunkBytes: Number(process.env.CAPTION_MAX_CHUNK_BYTES || 256000),
  },
};

export function livekitConfigured() {
  const { url, apiKey, apiSecret } = config.livekit;
  return Boolean(url && apiKey && apiSecret);
}
