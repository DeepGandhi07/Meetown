import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "node:http";
import { Server } from "socket.io";
import * as mediasoup from "mediasoup";
import { randomUUID } from "node:crypto";

const app = express();
const configuredOrigins = (
  process.env.CLIENT_ORIGINS ||
  process.env.CLIENT_ORIGIN ||
  "http://localhost:5173,http://127.0.0.1:5173"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function isAllowedDevelopmentOrigin(origin) {
  if (!origin) return true; // CLI health checks and native clients.
  if (configuredOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const host = url.hostname;
    if (["localhost", "127.0.0.1"].includes(host)) return true;
    // Allow private IPv4 LAN addresses only, so a phone can use the dev server.
    return (
      /^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host) ||
      /^192\.168\.(?:\d{1,3}\.)\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}$/.test(host)
    );
  } catch {
    return false;
  }
}
const corsOptions = {
  origin(origin, callback) {
    callback(
      isAllowedDevelopmentOrigin(origin)
        ? null
        : new Error(`Origin not allowed: ${origin}`),
      isAllowedDevelopmentOrigin(origin),
    );
  },
  methods: ["GET", "POST", "OPTIONS"],
};
app.use(cors(corsOptions));
app.use(express.json());

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: corsOptions,
  transports: ["websocket", "polling"],
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    database: databaseEnabled ? "configured" : "not-configured",
  });
});

const rooms = new Map();

// Supabase is accessed only from this server. Never expose the service-role key to Vite.
const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const databaseEnabled = Boolean(supabaseUrl && supabaseServiceKey);

async function databaseRequest(path, { method = "GET", body, prefer } = {}) {
  if (!databaseEnabled)
    throw new Error(
      "Hosted database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.",
    );
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: supabaseServiceKey,
      authorization: `Bearer ${supabaseServiceKey}`,
      "content-type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8000),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `Supabase request failed (${response.status}): ${text.slice(0, 240)}`,
    );
  return text ? JSON.parse(text) : null;
}

async function getMeetingHistory(roomId) {
  const room = encodeURIComponent(roomId);
  const [messages, notes] = await Promise.all([
    databaseRequest(
      `meeting_messages?room_id=eq.${room}&select=id,room_id,sender_name,message,created_at&order=created_at.asc&limit=200`,
    ),
    databaseRequest(
      `meeting_notes?room_id=eq.${room}&select=room_id,content,updated_at&limit=1`,
    ),
  ]);
  return { messages, notes: notes[0]?.content || "" };
}
const captionWorkerUrl =
  process.env.CAPTION_WORKER_URL || "http://127.0.0.1:8010";
const maxCaptionChunkBytes = Number(
  process.env.CAPTION_MAX_CHUNK_BYTES || 256000,
);
const deepgramApiKey = process.env.DEEPGRAM_API_KEY || "";
const captionProvider = (
  process.env.CAPTION_PROVIDER || "hybrid"
).toLowerCase();
const languageCodes = {
  English: "en",
  German: "de",
  Hindi: "hi",
  French: "fr",
  Spanish: "es",
  Portuguese: "pt",
  Japanese: "ja",
};
let worker;

const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {},
  },
];

async function getRoom(roomId) {
  let room = rooms.get(roomId);

  if (!room) {
    const router = await worker.createRouter({ mediaCodecs });

    room = {
      id: roomId,
      router,
      peers: new Map(),
    };

    rooms.set(roomId, room);
  }

  return room;
}

function getPeer(socket) {
  const room = rooms.get(socket.data.roomId);
  const peer = room?.peers.get(socket.id);

  if (!room || !peer) {
    throw new Error("Join a room first");
  }

  return { room, peer };
}

function closePeer(room, peerId) {
  const peer = room.peers.get(peerId);
  if (!peer) return;

  for (const producer of peer.producers.values()) {
    producer.close();
  }

  for (const consumer of peer.consumers.values()) {
    consumer.close();
  }

  for (const transport of peer.transports.values()) {
    transport.close();
  }

  room.peers.delete(peerId);

  io.to(room.id).emit("peer-left", { peerId });

  if (room.peers.size === 0) {
    room.router.close();
    rooms.delete(room.id);
  }
}

// Wrap request/response-style Socket.IO events in acknowledgements.
function register(socket, event, operation) {
  socket.on(event, async (data = {}, ack = () => {}) => {
    try {
      ack({ ok: true, data: await operation(data) });
    } catch (error) {
      ack({ ok: false, error: error.message });
    }
  });
}

async function createWebRtcTransport(router) {
  const announcedAddress = process.env.ANNOUNCED_IP || process.env.PUBLIC_IP;
  const listenInfo = {
    protocol: "udp",
    // Bind on all interfaces; announce the PC's LAN IP for phones on the same Wi-Fi.
    ip: process.env.LISTEN_IP || "0.0.0.0",
  };

  if (announcedAddress) {
    listenInfo.announcedAddress = announcedAddress;
  }

  return router.createWebRtcTransport({
    listenInfos: [listenInfo],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  });
}

io.on("connection", (socket) => {
  socket.on("join-room", async (data = {}, ack = () => {}) => {
    try {
      const roomId = String(data.roomId || "").trim();
      if (!roomId) {
        throw new Error("Room ID is required");
      }
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(roomId)) {
        throw new Error("Use a valid room ID");
      }

      // A basic safety limit for the initial prototype.
      let room = await getRoom(roomId);

      if (room.peers.size >= 100) {
        throw new Error("This room is full");
      }

      const peer = {
        id: socket.id,
        name: String(data.name || "Guest").slice(0, 60),
        captionPreferences: {
          enabled: true,
          sourceLanguage: "auto",
          targetLanguage: "English",
        },
        captionBusy: false,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
      };

      room.peers.set(socket.id, peer);
      socket.data.roomId = roomId;
      await socket.join(roomId);

      const existingProducers = [];

      for (const [peerId, otherPeer] of room.peers) {
        if (peerId === socket.id) continue;

        for (const producer of otherPeer.producers.values()) {
          existingProducers.push({
            producerId: producer.id,
            peerId,
            kind: producer.kind,
            name: otherPeer.name,
          });
        }
      }

      ack({
        ok: true,
        data: {
          peerId: socket.id,
          routerRtpCapabilities: room.router.rtpCapabilities,
          existingProducers,
          peers: [...room.peers.values()].map((p) => ({
            peerId: p.id,
            name: p.name,
          })),
        },
      });

      socket.to(roomId).emit("peer-joined", {
        peerId: socket.id,
        name: peer.name,
      });
    } catch (error) {
      ack({ ok: false, error: error.message });
    }
  });

  register(socket, "meeting:get-history", async () => {
    const { room } = getPeer(socket);
    if (!databaseEnabled)
      return { messages: [], notes: "", persistence: "not-configured" };
    try {
      const history = await getMeetingHistory(room.id);
      return { ...history, persistence: "hosted" };
    } catch (error) {
      console.error("Could not load meeting history:", error.message);
      return { messages: [], notes: "", persistence: "unavailable" };
    }
  });

  socket.on("chat:send", async (payload = {}, ack = () => {}) => {
    try {
      const { room, peer } = getPeer(socket);
      const message = String(payload.message || "")
        .trim()
        .slice(0, 2000);
      if (!message) throw new Error("Write a message before sending.");
      if (!databaseEnabled)
        throw new Error(
          "Hosted database is not configured; chat cannot be saved.",
        );
      const rows = await databaseRequest("meeting_messages", {
        method: "POST",
        body: {
          room_id: room.id,
          sender_id: socket.id,
          sender_name: peer.name,
          message,
        },
        prefer: "return=representation",
      });
      const saved = rows?.[0];
      if (!saved)
        throw new Error("The database did not return the saved message.");
      io.to(room.id).emit("chat:message", saved);
      ack({ ok: true, data: saved });
    } catch (error) {
      ack({ ok: false, error: error.message });
    }
  });

  socket.on("notes:update", async (payload = {}, ack = () => {}) => {
    try {
      const { room, peer } = getPeer(socket);
      const content = String(payload.content || "").slice(0, 50000);
      if (!databaseEnabled)
        throw new Error(
          "Hosted database is not configured; notes cannot be saved.",
        );
      const rows = await databaseRequest("meeting_notes?on_conflict=room_id", {
        method: "POST",
        body: {
          room_id: room.id,
          content,
          updated_by: peer.name,
          updated_at: new Date().toISOString(),
        },
        prefer: "resolution=merge-duplicates,return=representation",
      });
      const saved = rows?.[0] || {
        room_id: room.id,
        content,
        updated_at: new Date().toISOString(),
      };
      io.to(room.id).emit("notes:updated", saved);
      ack({ ok: true, data: saved });
    } catch (error) {
      ack({ ok: false, error: error.message });
    }
  });

  register(socket, "create-transport", async () => {
    const { room, peer } = getPeer(socket);
    const transport = await createWebRtcTransport(room.router);

    peer.transports.set(transport.id, transport);

    transport.on("dtlsstatechange", (state) => {
      if (state === "closed") transport.close();
    });

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
    };
  });

  register(
    socket,
    "connect-transport",
    async ({ transportId, dtlsParameters }) => {
      const { peer } = getPeer(socket);
      const transport = peer.transports.get(transportId);

      if (!transport) throw new Error("Transport not found");

      await transport.connect({ dtlsParameters });
      return { connected: true };
    },
  );

  register(socket, "produce", async ({ transportId, kind, rtpParameters }) => {
    const { room, peer } = getPeer(socket);
    const transport = peer.transports.get(transportId);

    if (!transport) throw new Error("Transport not found");

    const producer = await transport.produce({
      kind,
      rtpParameters,
    });

    peer.producers.set(producer.id, producer);

    producer.on("transportclose", () => {
      peer.producers.delete(producer.id);
    });

    socket.to(room.id).emit("new-producer", {
      producerId: producer.id,
      peerId: socket.id,
      kind: producer.kind,
      name: peer.name,
    });

    return { id: producer.id };
  });

  register(socket, "consume", async ({ transportId, producerId }) => {
    const { room, peer } = getPeer(socket);
    const transport = peer.transports.get(transportId);

    if (!transport) throw new Error("Transport not found");
    if (
      !room.router.canConsume({
        producerId,
        rtpCapabilities: peer.rtpCapabilities,
      })
    ) {
      throw new Error("Cannot consume this media stream");
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities: peer.rtpCapabilities,
      paused: true,
    });

    peer.consumers.set(consumer.id, consumer);

    consumer.on("transportclose", () => {
      peer.consumers.delete(consumer.id);
    });

    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    };
  });

  socket.on("caption:set-preferences", (data = {}) => {
    const room = rooms.get(socket.data.roomId);
    const peer = room?.peers.get(socket.id);
    if (!peer) return;
    const targetLanguage = Object.hasOwn(languageCodes, data.targetLanguage)
      ? data.targetLanguage
      : "English";
    const sourceLanguage =
      data.sourceLanguage === "auto"
        ? "auto"
        : Object.hasOwn(languageCodes, data.sourceLanguage)
          ? languageCodes[data.sourceLanguage]
          : Object.values(languageCodes).includes(data.sourceLanguage)
            ? data.sourceLanguage
            : "auto";
    peer.captionPreferences = {
      enabled: data.enabled !== false,
      sourceLanguage,
      targetLanguage,
    };
  });

  socket.on("caption:audio-chunk", async (payload = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.roomId);
    const peer = room?.peers.get(socket.id);
    if (!room || !peer || !peer.captionPreferences?.enabled) {
      ack({
        ok: false,
        error: "Captions are disabled or the room is not joined",
      });
      return;
    }
    if (peer.captionBusy) {
      ack({ ok: false, error: "A caption chunk is already being processed" });
      return;
    }

    const audio = Buffer.isBuffer(payload.audio)
      ? payload.audio
      : Buffer.from(payload.audio || []);
    if (
      !audio.length ||
      audio.length > maxCaptionChunkBytes ||
      audio.length % 2 !== 0
    ) {
      ack({ ok: false, error: "Invalid audio chunk size" });
      return;
    }
    peer.captionBusy = true;
    let ackSent = false;
    try {
      const sourcePref = peer.captionPreferences.sourceLanguage;
      const requestedCode = sourcePref === "auto" ? "auto" : sourcePref;
      let transcript;
      let providerUsed = "local";

      // Cloud-first speech recognition, with automatic local Faster-Whisper fallback.
      if (captionProvider !== "local" && deepgramApiKey) {
        try {
          const params = new URLSearchParams({
            model: process.env.DEEPGRAM_MODEL || "nova-3",
            encoding: "linear16",
            sample_rate: "16000",
            channels: "1",
            smart_format: "true",
          });
          if (requestedCode === "auto") params.set("detect_language", "true");
          else params.set("language", requestedCode);
          const cloudResponse = await fetch(
            `https://api.deepgram.com/v1/listen?${params}`,
            {
              method: "POST",
              headers: {
                authorization: `Token ${deepgramApiKey}`,
                "content-type": "application/octet-stream",
              },
              body: audio,
              signal: AbortSignal.timeout(12000),
            },
          );
          if (!cloudResponse.ok)
            throw new Error(`Deepgram returned HTTP ${cloudResponse.status}`);
          const cloudJson = await cloudResponse.json();
          const channel = cloudJson.results?.channels?.[0];
          const alternative = channel?.alternatives?.[0];
          const cloudText = String(alternative?.transcript || "").trim();
          if (!cloudText)
            throw new Error(
              "Cloud provider returned no transcript; using local fallback",
            );
          transcript = {
            text: cloudText,
            language:
              channel?.detected_language ||
              alternative?.languages?.[0] ||
              requestedCode ||
              "und",
          };
          providerUsed = "deepgram";
        } catch (cloudError) {
          console.warn(
            "Cloud transcription failed; falling back to local Faster-Whisper:",
            cloudError.message,
          );
        }
      }

      if (!transcript) {
        const transcriptionResponse = await fetch(
          `${captionWorkerUrl}/transcribe?language=${encodeURIComponent(requestedCode)}`,
          {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: audio,
            signal: AbortSignal.timeout(30000),
          },
        );
        if (!transcriptionResponse.ok)
          throw new Error(
            `Local caption worker returned ${transcriptionResponse.status}`,
          );
        transcript = await transcriptionResponse.json();
      }

      const originalText = String(transcript.text || "")
        .trim()
        .slice(0, 2000);
      const sourceCode = String(
        transcript.language ||
          (requestedCode === "auto" ? "und" : requestedCode),
      ).slice(0, 5);
      if (!originalText) {
        peer.captionBusy = false;
        ack({ ok: true, data: { empty: true, provider: providerUsed } });
        ackSent = true;
        return;
      }
      const sourceLanguage =
        Object.entries(languageCodes).find(
          ([, code]) => code === sourceCode,
        )?.[0] || sourceCode;
      const captionId = randomUUID();

      // Release the recognition lock and acknowledge before translation, so the next
      // audio chunk can be recognized while this caption is being translated.
      peer.captionBusy = false;
      ack({ ok: true, data: { provider: providerUsed } });
      ackSent = true;

      // Display recognized words immediately; a second event updates the same caption with translation.
      for (const recipient of room.peers.values()) {
        if (!recipient.captionPreferences?.enabled) continue;
        io.to(recipient.id).emit("caption:result", {
          id: captionId,
          speakerId: socket.id,
          speakerName: peer.name,
          sourceLanguage,
          targetLanguage:
            recipient.captionPreferences.targetLanguage || "English",
          originalText,
          translatedText: "",
          translationAvailable: false,
          isFinal: false,
          timestamp: Date.now(),
          provider: providerUsed,
        });
      }

      // Translation runs after the original transcript has already reached participants.
      await Promise.all(
        [...room.peers.values()].map(async (recipient) => {
          const preferences = recipient.captionPreferences;
          if (!preferences?.enabled) return;
          const targetLanguage = preferences.targetLanguage || "English";
          const targetCode = languageCodes[targetLanguage] || "en";
          let translatedText = "";
          let translationAvailable = false;
          if (targetCode === sourceCode) {
            translatedText = originalText;
            translationAvailable = true;
          } else {
            try {
              const response = await fetch(`${captionWorkerUrl}/translate`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  text: originalText,
                  source_language: sourceCode,
                  target_language: targetCode,
                }),
                signal: AbortSignal.timeout(15000),
              });
              if (response.ok) {
                translatedText = String(
                  (await response.json()).text || "",
                ).slice(0, 2000);
                translationAvailable = Boolean(translatedText);
              }
            } catch (translationError) {
              console.warn(
                "Caption translation unavailable:",
                translationError.message,
              );
            }
          }
          io.to(recipient.id).emit("caption:result", {
            id: captionId,
            speakerId: socket.id,
            speakerName: peer.name,
            sourceLanguage,
            targetLanguage,
            originalText,
            translatedText,
            translationAvailable,
            isFinal: true,
            timestamp: Date.now(),
            provider: providerUsed,
          });
        }),
      );
    } catch (error) {
      if (!ackSent) ack({ ok: false, error: error.message });
      socket.emit("caption:worker-error", {
        message:
          "Caption recognition failed. Check the cloud API key and/or local caption worker.",
      });
      console.warn("Caption recognition failed:", error.message);
    } finally {
      if (!ackSent) peer.captionBusy = false;
    }
  });

  register(socket, "set-rtp-capabilities", async ({ rtpCapabilities }) => {
    const { peer } = getPeer(socket);
    peer.rtpCapabilities = rtpCapabilities;
    return { saved: true };
  });

  register(socket, "resume-consumer", async ({ consumerId }) => {
    const { peer } = getPeer(socket);
    const consumer = peer.consumers.get(consumerId);

    if (!consumer) throw new Error("Consumer not found");

    await consumer.resume();
    return { resumed: true };
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomId);
    if (room) closePeer(room, socket.id);
  });
});

async function start() {
  worker = await mediasoup.createWorker({
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
  });

  worker.on("died", () => {
    console.error("mediasoup worker died");
    process.exit(1);
  });

  const port = Number(process.env.PORT || 3003);

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`Signaling server listening on port ${port}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
