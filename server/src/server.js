import express from "express";
import cors from "cors";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { AccessToken, TokenVerifier } from "livekit-server-sdk";
import { config, livekitConfigured } from "./config.js";
import * as db from "./db.js";
import {
  LANGUAGE_CODES,
  CaptionUnavailableError,
  captionHealth,
  captionsAvailable,
  languageName,
  transcribe,
  translate,
} from "./captions.js";

const ROOM_ID = /^[A-Za-z0-9_-]{3,64}$/;
const log = (...args) => console.log(new Date().toISOString(), ...args);

/* ----------------------------- CORS / HTTP ----------------------------- */

function originAllowed(origin) {
  if (!origin) return true; // curl, health checks, native apps
  if (config.clientOrigins.includes(origin)) return true;
  if (!config.allowLanOrigins) return false;
  try {
    const { hostname } = new URL(origin);
    return (
      ["localhost", "127.0.0.1"].includes(hostname) ||
      /^10\.\d+\.\d+\.\d+$/.test(hostname) ||
      /^192\.168\.\d+\.\d+$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)
    );
  } catch {
    return false;
  }
}
const corsOptions = {
  origin: (origin, cb) => cb(null, originAllowed(origin)),
  methods: ["GET", "POST", "OPTIONS"],
};

const app = express();
app.set("trust proxy", 1); // behind Render / Caddy
app.use(cors(corsOptions));
app.use(express.json({ limit: "10kb" }));

// Tiny fixed-window rate limiter (per IP) — enough to blunt token farming.
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.path}:${req.ip}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    if (++entry.count > max) {
      res.set("Retry-After", String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: "Too many requests. Try again shortly." });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) if (now > entry.reset) hits.delete(key);
}, 60000).unref();

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    livekit: livekitConfigured() ? "configured" : "missing-config",
    database: db.databaseEnabled ? "supabase" : "memory",
    captions: { available: captionsAvailable(), providers: captionHealth() },
  });
});

/** Creates a hard-to-guess meeting ID, e.g. "k7q-m2xd-9hpa". */
app.post("/api/meetings", rateLimit(30, 60000), (_req, res) => {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const part = (n) =>
    Array.from({ length: n }, () =>
      alphabet[Math.floor(Math.random() * alphabet.length)],
    ).join("");
  res.json({ roomId: `${part(3)}-${part(4)}-${part(4)}` });
});

/** Issues a short-lived LiveKit access token for one participant in one room. */
app.post("/api/token", rateLimit(40, 60000), async (req, res) => {
  if (!livekitConfigured()) {
    return res.status(503).json({
      error: "Media server is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.",
    });
  }
  const roomId = String(req.body?.roomId ?? "").trim();
  const name = String(req.body?.name ?? "").trim().slice(0, 60);
  if (!ROOM_ID.test(roomId)) {
    return res.status(400).json({
      error: "Meeting ID must be 3–64 characters: letters, numbers, - or _.",
    });
  }
  if (!name) return res.status(400).json({ error: "Enter your display name." });

  const identity = `${randomUUID()}`;
  const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity,
    name,
    ttl: "4h", // also authorises the chat/caption socket, including reconnects
  });
  token.addGrant({
    room: roomId,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  res.json({
    url: config.livekit.url,
    token: await token.toJwt(),
    identity,
    roomId,
    name,
  });
});

/* ------------------------------ Socket.IO ------------------------------ */

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: corsOptions,
  transports: ["websocket", "polling"],
  maxHttpBufferSize: config.captions.maxChunkBytes + 4096,
  pingInterval: 20000,
  pingTimeout: 25000,
});

const verifier = livekitConfigured()
  ? new TokenVerifier(config.livekit.apiKey, config.livekit.apiSecret)
  : null;

/** roomId -> Map<socketId, peer> */
const rooms = new Map();

function ackWrap(handler) {
  return async (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    try {
      reply({ ok: true, data: (await handler(payload ?? {})) ?? {} });
    } catch (error) {
      reply({ ok: false, error: error.message || "Request failed" });
    }
  };
}

io.on("connection", (socket) => {
  const peerOf = () => rooms.get(socket.data.roomId)?.get(socket.id);
  const requirePeer = () => {
    const peer = peerOf();
    if (!peer) throw new Error("Join the meeting first.");
    return peer;
  };

  socket.on(
    "join-room",
    ackWrap(async ({ token }) => {
      if (!verifier) throw new Error("Server is not configured for meetings.");
      let claims;
      try {
        claims = await verifier.verify(String(token ?? ""));
      } catch {
        throw new Error("Your meeting session expired. Rejoin the meeting.");
      }
      const roomId = claims.video?.room;
      if (!roomId || !ROOM_ID.test(roomId)) throw new Error("Invalid meeting.");

      leaveRoom(); // re-join on reconnect replaces the old entry
      const peer = {
        socketId: socket.id,
        identity: claims.sub,
        name: claims.name || "Participant",
        captions: { enabled: false, sourceCode: "auto", target: "English" },
        busy: false,
        lastStatus: { state: "", at: 0 },
      };
      socket.data.roomId = roomId;
      if (!rooms.has(roomId)) rooms.set(roomId, new Map());
      rooms.get(roomId).set(socket.id, peer);
      socket.join(roomId);

      let history = { messages: [], notes: "", persistence: "unavailable" };
      try {
        history = await db.getHistory(roomId);
      } catch (error) {
        log("history unavailable:", error.message);
      }
      return { history, captionsAvailable: captionsAvailable() };
    }),
  );

  socket.on(
    "chat:send",
    ackWrap(async ({ text }) => {
      const peer = requirePeer();
      const clean = String(text ?? "").trim().slice(0, 2000);
      if (!clean) throw new Error("Message is empty.");
      const message = await db.saveMessage({
        roomId: socket.data.roomId,
        identity: peer.identity,
        name: peer.name,
        text: clean,
      });
      io.to(socket.data.roomId).emit("chat:message", message);
      return { id: message.id };
    }),
  );

  socket.on(
    "notes:update",
    ackWrap(async ({ content }) => {
      requirePeer();
      const clean = String(content ?? "").slice(0, 50000);
      await db.saveNotes(socket.data.roomId, clean);
      socket.to(socket.data.roomId).emit("notes:updated", { content: clean });
    }),
  );

  /* ------------------------------ captions ------------------------------ */

  socket.on("caption:set-preferences", (data = {}) => {
    const peer = peerOf();
    if (!peer) return;
    const target = Object.hasOwn(LANGUAGE_CODES, data.targetLanguage)
      ? data.targetLanguage
      : "English";
    const source =
      data.sourceLanguage === "auto"
        ? "auto"
        : LANGUAGE_CODES[data.sourceLanguage] ?? "auto";
    peer.captions = { enabled: data.enabled !== false, sourceCode: source, target };
  });

  function notifyStatus(peer, state, message) {
    const now = Date.now();
    // Only tell the client when the state changes (or every 30s), never a stream of errors.
    if (peer.lastStatus.state === state && now - peer.lastStatus.at < 30000) return;
    peer.lastStatus = { state, at: now };
    socket.emit("caption:status", { state, message });
  }

  socket.on("caption:audio-chunk", async (payload = {}, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const peer = peerOf();
    if (!peer?.captions.enabled) return reply({ ok: false, error: "Captions are off." });
    if (peer.busy) return reply({ ok: true, data: { skipped: true } });

    const audio = Buffer.isBuffer(payload.audio)
      ? payload.audio
      : Buffer.from(payload.audio ?? []);
    if (!audio.length || audio.length > config.captions.maxChunkBytes || audio.length % 2) {
      return reply({ ok: false, error: "Invalid audio chunk." });
    }

    peer.busy = true;
    try {
      const { text, language, provider } = await transcribe(audio, peer.captions.sourceCode);
      reply({ ok: true, data: { provider } }); // free the client for the next chunk right away
      notifyStatus(peer, "ready");
      if (!text) return;
      await fanOutCaption(peer, text.slice(0, 2000), language);
    } catch (error) {
      if (error instanceof CaptionUnavailableError) {
        notifyStatus(peer, "unavailable", error.message);
        reply({ ok: true, data: { unavailable: true } }); // never an error loop
      } else {
        log("caption error:", error.message);
        reply({ ok: false, error: "Caption processing failed." });
      }
    } finally {
      peer.busy = false;
    }
  });

  async function fanOutCaption(speaker, originalText, sourceCode) {
    const roomPeers = [...(rooms.get(socket.data.roomId)?.values() ?? [])].filter(
      (p) => p.captions.enabled,
    );
    if (!roomPeers.length) return;

    const id = randomUUID();
    const base = {
      id,
      speakerId: speaker.identity,
      speakerName: speaker.name,
      sourceLanguage: languageName(sourceCode),
      originalText,
    };

    // 1) Original text goes out immediately.
    for (const p of roomPeers) {
      io.to(p.socketId).emit("caption:result", {
        ...base,
        targetLanguage: p.captions.target,
        translatedText: "",
        isFinal: false,
        timestamp: Date.now(),
      });
    }

    // 2) Translate once per distinct target language, then deliver.
    const targets = [...new Set(roomPeers.map((p) => p.captions.target))];
    const translations = new Map(
      await Promise.all(
        targets.map(async (target) => [
          target,
          await translate(originalText, sourceCode, LANGUAGE_CODES[target]),
        ]),
      ),
    );
    for (const p of roomPeers) {
      const translatedText = translations.get(p.captions.target) ?? "";
      io.to(p.socketId).emit("caption:result", {
        ...base,
        targetLanguage: p.captions.target,
        translatedText,
        translationAvailable: Boolean(translatedText),
        isFinal: true,
        timestamp: Date.now(),
      });
    }
  }

  /* ------------------------------ lifecycle ------------------------------ */

  function leaveRoom() {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const peers = rooms.get(roomId);
    peers?.delete(socket.id);
    if (peers && peers.size === 0) rooms.delete(roomId);
    socket.leave(roomId);
    socket.data.roomId = undefined;
  }
  socket.on("leave-room", leaveRoom);
  socket.on("disconnect", leaveRoom);
});

/* ------------------------------- startup -------------------------------- */

if (!livekitConfigured()) {
  log("WARNING: LiveKit is not configured — /api/token will return 503.");
}
httpServer.listen(config.port, "0.0.0.0", () => {
  log(`Meetown server listening on :${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log(`${signal} received, shutting down`);
    io.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
