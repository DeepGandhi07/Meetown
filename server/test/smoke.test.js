import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { io } from "socket.io-client";

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

before(async () => {
  proc = spawn("node", ["src/server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      LIVEKIT_URL: "wss://example.test",
      LIVEKIT_API_KEY: "testkey",
      LIVEKIT_API_SECRET: "testsecret-testsecret-testsecret-1234",
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      DEEPGRAM_API_KEY: "",
      CAPTION_PROVIDER: "local",
      CAPTION_WORKER_URL: "http://127.0.0.1:1", // nothing listens: simulates an outage
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
after(() => proc?.kill());

const post = (path, body) =>
  fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const emit = (socket, event, data) =>
  new Promise((resolve) => socket.timeout(5000).emit(event, data, (err, res) => resolve(err ? { ok: false, error: "timeout" } : res)));
const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

async function join(roomId, name) {
  const { token, identity } = await (await post("/api/token", { roomId, name })).json();
  const socket = io(BASE, { transports: ["websocket"] });
  await once(socket, "connect");
  const res = await emit(socket, "join-room", { token });
  assert.equal(res.ok, true, res.error);
  return { socket, identity, name };
}

test("creates unique, well-formed meeting IDs", async () => {
  const a = (await (await post("/api/meetings", {})).json()).roomId;
  const b = (await (await post("/api/meetings", {})).json()).roomId;
  assert.match(a, /^[a-z2-9]{3}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.notEqual(a, b);
});

test("token endpoint validates input", async () => {
  assert.equal((await post("/api/token", { roomId: "x", name: "A" })).status, 400);
  assert.equal((await post("/api/token", { roomId: "good-room", name: "  " })).status, 400);
  const ok = await post("/api/token", { roomId: "good-room", name: "Ann" });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(body.token.split(".").length === 3);
  assert.equal(body.url, "wss://example.test");
});

test("socket join rejects forged tokens", async () => {
  const socket = io(BASE, { transports: ["websocket"] });
  await once(socket, "connect");
  const res = await emit(socket, "join-room", { token: "not-a-jwt" });
  assert.equal(res.ok, false);
  socket.close();
});

test("chat and notes sync between participants and persist for late joiners", async () => {
  const a = await join("chat-room", "Ann");
  const b = await join("chat-room", "Bob");
  const incoming = once(b.socket, "chat:message");
  assert.equal((await emit(a.socket, "chat:send", { text: "hello team" })).ok, true);
  const msg = await incoming;
  assert.equal(msg.text, "hello team");
  assert.equal(msg.name, "Ann");

  const notesSeen = once(b.socket, "notes:updated");
  await emit(a.socket, "notes:update", { content: "Decision: ship it" });
  assert.equal((await notesSeen).content, "Decision: ship it");

  const c = await join("chat-room", "Cy"); // late joiner gets history
  const again = await emit(c.socket, "join-room", { token: (await (await post("/api/token", { roomId: "chat-room", name: "Cy" })).json()).token });
  assert.equal(again.data.history.messages.length, 1);
  assert.equal(again.data.history.notes, "Decision: ship it");
  [a, b, c].forEach((p) => p.socket.close());
});

test("a caption provider outage reports once and never blocks or errors", async () => {
  const a = await join("cap-room", "Ann");
  a.socket.emit("caption:set-preferences", { enabled: true, sourceLanguage: "auto", targetLanguage: "English" });
  const statusEvents = [];
  a.socket.on("caption:status", (s) => statusEvents.push(s));
  const pcm = Buffer.alloc(64000); // 2 s of silence, valid size
  for (let i = 0; i < 4; i++) {
    const res = await emit(a.socket, "caption:audio-chunk", { audio: pcm });
    assert.equal(res.ok, true, "acks must succeed even when the provider is down");
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(statusEvents.length, 1, "only one status message, not one per chunk");
  assert.equal(statusEvents[0].state, "unavailable");
  const health = await (await fetch(`${BASE}/health`)).json();
  assert.equal(health.captions.providers.worker.open, true); // breaker opened
  a.socket.close();
});
