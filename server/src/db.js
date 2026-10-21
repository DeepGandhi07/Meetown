import { randomUUID } from "node:crypto";
import { config } from "./config.js";

const { url, serviceKey } = config.supabase;
export const databaseEnabled = Boolean(url && serviceKey);

// In-memory fallback so local development works without Supabase.
const memory = { messages: new Map(), notes: new Map() };

async function rest(path, { method = "GET", body, prefer } = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function getHistory(roomId) {
  if (!databaseEnabled) {
    return {
      messages: memory.messages.get(roomId) ?? [],
      notes: memory.notes.get(roomId) ?? "",
      persistence: "memory",
    };
  }
  const room = encodeURIComponent(roomId);
  const [messages, notes] = await Promise.all([
    rest(
      `meeting_messages?room_id=eq.${room}&select=id,sender_identity,sender_name,message,created_at&order=created_at.asc&limit=200`,
    ),
    rest(`meeting_notes?room_id=eq.${room}&select=content&limit=1`),
  ]);
  return {
    messages: messages.map(toClientMessage),
    notes: notes[0]?.content ?? "",
    persistence: "database",
  };
}

function toClientMessage(row) {
  return {
    id: row.id,
    identity: row.sender_identity,
    name: row.sender_name,
    text: row.message,
    createdAt: row.created_at,
  };
}

export async function saveMessage({ roomId, identity, name, text }) {
  if (!databaseEnabled) {
    const message = {
      id: randomUUID(),
      identity,
      name,
      text,
      createdAt: new Date().toISOString(),
    };
    const list = memory.messages.get(roomId) ?? [];
    list.push(message);
    memory.messages.set(roomId, list.slice(-200));
    return message;
  }
  const rows = await rest("meeting_messages", {
    method: "POST",
    prefer: "return=representation",
    body: {
      room_id: roomId,
      sender_identity: identity,
      sender_name: name,
      message: text,
    },
  });
  return toClientMessage(rows[0]);
}

export async function saveNotes(roomId, content) {
  if (!databaseEnabled) {
    memory.notes.set(roomId, content);
    return;
  }
  await rest("meeting_notes?on_conflict=room_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates",
    body: { room_id: roomId, content, updated_at: new Date().toISOString() },
  });
}
