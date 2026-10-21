export const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

async function post(path, body) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      "Cannot reach the Meetown server. Check your connection and try again.",
    );
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export const createMeetingId = () => post("/api/meetings", {}).then((d) => d.roomId);
export const fetchJoinToken = (roomId, name) => post("/api/token", { roomId, name });
