import { useEffect, useMemo, useState } from "react";
import VideoTile from "./components/meeting/VideoTile.jsx";
import LiveCaptionOverlay from "./components/captions/LiveCaptionOverlay.jsx";
import CaptionPanel from "./components/captions/CaptionPanel.jsx";
import { useLiveCaptions } from "./hooks/useLiveCaptions.js";
import { useCaptionAudio } from "./hooks/useCaptionAudio.js";
import { useMeeting } from "./hooks/useMeeting.js";
import { createMeetingId } from "./services/api.js";

const CONNECTION_LABEL = {
  connected: "Room is active",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
};

function readStored(key, fallback) {
  try {
    return window.localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function useIsMobile() {
  const query = "(max-width: 560px)";
  const [mobile, setMobile] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMobile(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

function gridColumns(count, mobile) {
  if (mobile) return count <= 2 ? 1 : 2;
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

export default function App() {
  const initialRoom = new URLSearchParams(window.location.search).get("room");
  const [roomId, setRoomId] = useState(initialRoom || "team-meeting");
  const [name, setName] = useState(() => readStored("meetown:name", "Guest"));
  const [activePanel, setActivePanel] = useState("translate");
  const [targetLanguage, setTargetLanguage] = useState("English");
  const [sourceLanguage, setSourceLanguage] = useState("auto");
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [chatDraft, setChatDraft] = useState("");
  const [chatError, setChatError] = useState("");
  const [page, setPage] = useState(0);
  const [copied, setCopied] = useState(false);
  const mobile = useIsMobile();

  const meeting = useMeeting();
  const {
    joined, joining, connection, error, notice, tiles, me, socket, socketEpoch,
    localAudioStream, audioBlocked, devices, activeDevices, chatMessages,
    persistence, notes, notesState,
  } = meeting;

  const localTile = tiles.find((tile) => tile.local && !tile.screen);
  const muted = localTile ? localTile.micMuted : false;
  const cameraOff = localTile ? !localTile.hasVideo : false;
  const canShareScreen =
    typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia);
  const sharingScreen = tiles.some((tile) => tile.local && tile.screen);

  const {
    captions,
    connectionState: captionConnectionState,
    statusMessage: captionStatusMessage,
    addPreviewCaption,
    clearCaptions,
  } = useLiveCaptions({
    socket,
    enabled: joined && captionsEnabled,
    targetLanguage,
    sourceLanguage,
  });
  useCaptionAudio({
    stream: joined ? localAudioStream : null,
    socket,
    enabled: joined && captionsEnabled && !muted,
    sourceLanguage,
    targetLanguage,
    epoch: socketEpoch,
  });

  async function joinMeeting() {
    try {
      window.localStorage.setItem("meetown:name", name.trim());
    } catch {
      /* storage can be unavailable (private mode) */
    }
    setPage(0);
    await meeting.join({ roomId, name });
  }

  async function generateMeetingId() {
    try {
      setRoomId(await createMeetingId());
    } catch {
      /* the server error will surface on join */
    }
  }

  const inviteLink = `${window.location.origin}/?room=${encodeURIComponent(roomId)}`;
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this invite link:", inviteLink);
    }
  }

  // Paging: 12 tiles per page on desktop, 4 on phones. The newest remote speaker is kept on page 1.
  const pageSize = mobile ? 4 : 12;
  const ordered = useMemo(() => {
    const list = [...tiles];
    const screenIndex = list.findIndex((tile) => tile.screen);
    if (screenIndex > 0) list.unshift(...list.splice(screenIndex, 1));
    const speakerIndex = list.findIndex((tile) => tile.speaking && !tile.local && !tile.screen);
    if (speakerIndex >= pageSize) {
      [list[pageSize - 1], list[speakerIndex]] = [list[speakerIndex], list[pageSize - 1]];
    }
    return list;
  }, [tiles, pageSize]);
  const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visibleTiles = ordered.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const people = tiles.filter((tile) => !tile.screen);

  if (!joined) {
    return (
      <main className="app-shell home-shell">
        <aside className="home-rail">
          <div className="brand-mark">
            m<span>.</span>
          </div>
          <div className="rail-active">⌂</div>
          <div className="rail-icon">▦</div>
          <div className="rail-icon">⚙</div>
          <div className="rail-bottom">?</div>
        </aside>
        <section className="home-main">
          <header className="topbar">
            <div className="brand-lockup">
              <div className="brand-mark small">
                m<span>.</span>
              </div>
              <span>
                meet<span className="brand-accent">own</span>
              </span>
            </div>
            <div className="topbar-right">
              <span className="status-dot" />{" "}
              <span className="muted-label">Private by design</span>
              <div className="avatar-mini">G</div>
            </div>
          </header>
          <div className="home-content">
            <div className="eyebrow">
              <span className="eyebrow-line" /> YOUR SPACE, CONNECTED
            </div>
            <h1>
              Good conversations
              <br />
              have <span className="gradient-text">no language barrier.</span>
            </h1>
            <p className="hero-copy">
              Meet, share ideas, and understand each other — wherever the
              conversation takes you.
            </p>
            <div className="home-grid">
              <form
                className="join-card"
                onSubmit={(e) => {
                  e.preventDefault();
                  joinMeeting();
                }}
              >
                <div className="card-kicker">
                  <span className="live-pulse" /> START CONNECTING
                </div>
                <h2>Join your people.</h2>
                <p className="card-subtitle">
                  Enter a room or create a space for your team.
                </p>
                <label htmlFor="display-name">Your display name</label>
                <div className="input-wrap">
                  <span className="input-symbol">◉</span>
                  <input
                    id="display-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={60}
                    placeholder="How should people call you?"
                    autoComplete="nickname"
                    required
                  />
                </div>
                <label htmlFor="room-id">Meeting room</label>
                <div className="input-wrap">
                  <span className="input-symbol">⌘</span>
                  <input
                    id="room-id"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value)}
                    placeholder="e.g. product-sync"
                    pattern="[A-Za-z0-9_\-]{3,64}"
                    title="3–64 letters, numbers, - or _"
                    required
                  />
                </div>
                <button
                  type="button"
                  className="text-button new-id-button"
                  onClick={generateMeetingId}
                >
                  Generate a new meeting ID
                </button>
                <button className="primary-button" type="submit" disabled={joining}>
                  <span>{joining ? "Joining…" : "Join meeting"}</span>
                  <span className="button-arrow">↗</span>
                </button>
                {(error || notice) && (
                  <p className="error" role="alert">
                    {error || notice}
                  </p>
                )}
                <div className="secure-note">
                  <span>◇</span> Your conversation stays in your meeting space
                </div>
              </form>
              <div className="feature-column">
                <div className="translation-hero-card">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="translation-icon">
                    文<span>↔</span>A
                  </div>
                  <div className="translation-card-copy">
                    <span className="mini-label">MEETOWN TRANSLATE</span>
                    <h3>
                      Speak naturally.
                      <br />
                      <span className="gradient-text">
                        Understand instantly.
                      </span>
                    </h3>
                    <p>
                      Live captions with translation into your language, so
                      everyone can follow along.
                    </p>
                  </div>
                  <div className="language-pills">
                    <span>
                      DE <b>German</b>
                    </span>
                    <span className="swap-arrow">⇄</span>
                    <span>
                      EN <b>English</b>
                    </span>
                  </div>
                </div>
                <div className="mini-feature-grid">
                  <div className="mini-feature">
                    <span className="feature-icon violet">⌁</span>
                    <div>
                      <b>Clear by design</b>
                      <small>Focused calls, less clutter</small>
                    </div>
                  </div>
                  <div className="mini-feature">
                    <span className="feature-icon cyan">◇</span>
                    <div>
                      <b>Privacy-first</b>
                      <small>Self-hosted architecture</small>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <footer className="home-footer">
              <span>© 2026 Meetown</span>
              <span>Made for people, not language barriers.</span>
              <span>
                <i className="footer-dot" /> All systems designed to be
                self-hostable
              </span>
            </footer>
          </div>
        </section>
      </main>
    );
  }

  async function sendMessage(event) {
    event.preventDefault();
    const text = chatDraft.trim();
    if (!text) return;
    setChatError("");
    try {
      await meeting.sendChat(text);
      setChatDraft("");
    } catch (sendError) {
      setChatError(sendError.message || "Message could not be sent.");
    }
  }

  const panelTitle = {
    translate: "Live translate",
    chat: "Meeting chat",
    notes: "Shared notes",
    people: "Participants",
    settings: "Settings",
  }[activePanel];

  return (
    <main className="app-shell meeting-shell">
      <header className="meeting-topbar">
        <div className="brand-lockup">
          <div className="brand-mark small">
            m<span>.</span>
          </div>
          <span>
            meet<span className="brand-accent">own</span>
          </span>
          <span className="topbar-divider" />
        </div>
        <div className={`meeting-title conn-${connection}`}>
          <strong>{roomId}</strong>
          <span>
            <i className="footer-dot" /> {CONNECTION_LABEL[connection] || "Connecting…"}
          </span>
        </div>
        <div className="meeting-top-actions">
          <span className="encrypted-label">
            ◇ <span>Private room</span>
          </span>
          <button
            className="icon-button"
            title="Meeting settings"
            aria-label="Meeting settings"
            onClick={() => setActivePanel("settings")}
          >
            ⚙
          </button>
          <div className="avatar-mini">{(name || "G").slice(0, 1).toUpperCase()}</div>
        </div>
      </header>
      <div className="meeting-layout">
        <section className="call-stage">
          <div className="stage-heading">
            <div>
              <span className="eyebrow">LIVE SESSION</span>
              <h1>
                You're in the room<span className="heading-period">.</span>
              </h1>
            </div>
            <button
              type="button"
              className="participant-count"
              onClick={() => setActivePanel("people")}
              aria-label="Show participants"
            >
              <span className="participant-count-icon">♙</span>
              {people.length} <span>participants</span>
            </button>
          </div>
          {audioBlocked && (
            <div className="banner warn" role="alert">
              <span>Your browser is blocking meeting audio until you interact with the page.</span>
              <button className="text-button" onClick={meeting.startAudio}>
                Enable audio
              </button>
            </div>
          )}
          {connection === "disconnected" && (
            <div className="banner warn" role="alert">
              <span>{error || "You were disconnected from the meeting."}</span>
              <button className="text-button" onClick={meeting.rejoin}>
                Rejoin
              </button>
            </div>
          )}
          <section
            className="video-grid"
            data-cols-m={gridColumns(visibleTiles.length, true)}
            style={{
              "--cols": gridColumns(visibleTiles.length, false),
              "--cols-m": gridColumns(visibleTiles.length, true),
            }}
          >
            {visibleTiles.map((tile) => (
              <div
                className={`video-tile ${tile.local ? "local-tile" : ""} ${
                  tile.speaking ? "speaking-tile" : ""
                } ${tile.screen ? "screen-tile spotlight" : ""}`}
                key={tile.peerId}
              >
                <VideoTile
                  stream={tile.stream}
                  name={tile.local && !tile.screen ? `${tile.name} (You)` : tile.name}
                  muted={tile.local}
                  hasVideo={tile.hasVideo}
                  micMuted={tile.micMuted}
                  mirror={tile.local && !tile.screen}
                  fit={tile.screen ? "contain" : "cover"}
                />
                <span className={`tile-presence ${tile.quality === "poor" ? "tile-weak" : ""}`}>
                  <i /> {tile.local ? "You" : tile.quality === "poor" ? "Weak connection" : "Connected"}
                </span>
              </div>
            ))}
            {tiles.length === 0 && (
              <div className="empty-stage">
                <div className="empty-orb">✦</div>
                <h3>Getting your space ready</h3>
                <p>Your meeting tiles will appear here.</p>
              </div>
            )}
          </section>
          {pageCount > 1 && (
            <div className="grid-pager">
              <button
                className="icon-button"
                onClick={() => setPage(safePage - 1)}
                disabled={safePage === 0}
                aria-label="Previous page"
              >
                ‹
              </button>
              <span>
                Page {safePage + 1} of {pageCount}
              </span>
              <button
                className="icon-button"
                onClick={() => setPage(safePage + 1)}
                disabled={safePage >= pageCount - 1}
                aria-label="Next page"
              >
                ›
              </button>
            </div>
          )}
          <LiveCaptionOverlay captions={captions} enabled={captionsEnabled} />
          {notice && (
            <div className="banner warn" role="status">
              <span>{notice}</span>
              <button className="text-button" onClick={meeting.dismissNotice}>
                Dismiss
              </button>
            </div>
          )}
          {error && connection !== "disconnected" && (
            <p className="error meeting-error" role="alert">
              {error}
            </p>
          )}
          <div className="call-toolbar-wrap">
            <div className="call-toolbar">
              <button
                className={`control-button ${muted ? "control-off" : ""}`}
                onClick={meeting.toggleMicrophone}
              >
                <span className="control-glyph">{muted ? "♩̸" : "♩"}</span>
                <span>{muted ? "Unmute" : "Mute"}</span>
              </button>
              <button
                className={`control-button ${cameraOff ? "control-off" : ""}`}
                onClick={meeting.toggleCamera}
              >
                <span className="control-glyph">▣</span>
                <span>{cameraOff ? "Start video" : "Stop video"}</span>
              </button>
              {canShareScreen && !mobile && (
                <button
                  className={`control-button ${sharingScreen ? "control-selected" : ""}`}
                  onClick={meeting.toggleScreenShare}
                >
                  <span className="control-glyph">⇪</span>
                  <span>{sharingScreen ? "Stop share" : "Share"}</span>
                </button>
              )}
              <button
                className={`control-button ${activePanel === "translate" ? "control-selected" : ""}`}
                onClick={() => setActivePanel(activePanel === "translate" ? "" : "translate")}
              >
                <span className="control-glyph">文</span>
                <span>Translate</span>
              </button>
              <button
                className={`control-button ${activePanel === "chat" ? "control-selected" : ""}`}
                onClick={() => setActivePanel(activePanel === "chat" ? "" : "chat")}
              >
                <span className="control-glyph">▤</span>
                <span>Chat</span>
              </button>
              <button
                className={`control-button ${activePanel === "notes" ? "control-selected" : ""}`}
                onClick={() => setActivePanel(activePanel === "notes" ? "" : "notes")}
              >
                <span className="control-glyph">✎</span>
                <span>Notes</span>
              </button>
              <span className="toolbar-separator" />
              <button className="leave-button" onClick={meeting.leave}>
                <span>↗</span> Leave
              </button>
            </div>
            <div className="toolbar-hint">
              <span className="shortcut-key">⌘</span> Tip: choose Translate to configure your
              caption language
            </div>
          </div>
        </section>
        {activePanel && (
          <aside className="meeting-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">MEETING TOOLS</span>
                <h2>{panelTitle}</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setActivePanel("")}
                aria-label="Close panel"
              >
                ×
              </button>
            </div>
            <div className="panel-tabs">
              {[
                ["translate", "Translate"],
                ["chat", "Chat"],
                ["notes", "Notes"],
                ["people", "People"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={activePanel === key ? "active" : ""}
                  onClick={() => setActivePanel(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            {activePanel === "translate" && (
              <CaptionPanel
                enabled={captionsEnabled}
                onEnabledChange={setCaptionsEnabled}
                sourceLanguage={sourceLanguage}
                onSourceLanguageChange={setSourceLanguage}
                targetLanguage={targetLanguage}
                onTargetLanguageChange={setTargetLanguage}
                captions={captions}
                connectionState={captionConnectionState}
                statusMessage={captionStatusMessage}
                onPreviewCaption={addPreviewCaption}
                onClearCaptions={clearCaptions}
              />
            )}
            {activePanel === "chat" && (
              <div className="panel-content chat-panel">
                <div className="chat-intro">
                  Messages for <b>#{roomId}</b>
                </div>
                <div className="chat-messages">
                  {chatMessages.length === 0 ? (
                    <div className="chat-empty">
                      <span>▤</span>
                      <b>Start the conversation</b>
                      <p>Messages are shared with everyone in this meeting.</p>
                    </div>
                  ) : (
                    chatMessages.map((message) => (
                      <div
                        className={`chat-message ${message.identity === me.identity ? "own" : ""}`}
                        key={message.id}
                      >
                        <span className="chat-message-avatar">
                          {message.name.slice(0, 1).toUpperCase()}
                        </span>
                        <div>
                          <b>{message.name}</b>
                          <span className="chat-time">
                            {new Date(message.createdAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                          <p>{message.text}</p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <form className="chat-compose" onSubmit={sendMessage}>
                  <input
                    value={chatDraft}
                    onChange={(e) => setChatDraft(e.target.value)}
                    placeholder="Write a message…"
                    aria-label="Write a message"
                    maxLength={2000}
                  />
                  <button type="submit" aria-label="Send message">
                    ↗
                  </button>
                </form>
                {chatError && <p className="error">{chatError}</p>}
                <p className="panel-disclaimer">
                  {persistence === "database"
                    ? "Messages are saved with this meeting."
                    : "Messages are kept only while the server is running."}
                </p>
              </div>
            )}
            {activePanel === "notes" && (
              <div className="panel-content notes-panel">
                <div className="notes-toolbar">
                  <span>✎ &nbsp;Team notes</span>
                  <span className={`saved-label ${notesState === "error" ? "error-label" : ""}`}>
                    <i />{" "}
                    {{
                      saving: "Saving…",
                      saved: "Saved & shared",
                      error: "Not saved — retry by typing",
                    }[notesState] || "Not yet saved"}
                  </span>
                </div>
                <textarea
                  value={notes}
                  onChange={(e) => meeting.setNotes(e.target.value)}
                  placeholder={
                    "Capture decisions, ideas, and action items…\n\n• Decision:\n• Owner:\n• Next step:"
                  }
                  maxLength={50000}
                />
                <div className="notes-footnote">
                  Notes are shared live with everyone in the meeting.
                </div>
              </div>
            )}
            {activePanel === "people" && (
              <div className="panel-content">
                <ul className="people-list">
                  {people.map((person) => (
                    <li key={person.peerId}>
                      <span className="chat-message-avatar">
                        {person.name.slice(0, 1).toUpperCase()}
                      </span>
                      <b>
                        {person.name}
                        {person.local ? " (You)" : ""}
                      </b>
                      <span className="people-state">
                        <span className={person.micMuted ? "off" : ""}>
                          {person.micMuted ? "Mic off" : "Mic on"}
                        </span>
                        {" · "}
                        <span className={person.hasVideo ? "" : "off"}>
                          {person.hasVideo ? "Cam on" : "Cam off"}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <button className="secondary-button" onClick={copyInvite}>
                  {copied ? "Link copied" : "Copy invite link"}
                </button>
              </div>
            )}
            {activePanel === "settings" && (
              <div className="panel-content settings-panel">
                <h3>Meeting preferences</h3>
                <div className="settings-row">
                  <div>
                    <b>Translation captions</b>
                    <small>Show translated captions</small>
                  </div>
                  <button
                    className={`switch ${captionsEnabled ? "on" : ""}`}
                    onClick={() => setCaptionsEnabled(!captionsEnabled)}
                    role="switch"
                    aria-checked={captionsEnabled}
                    aria-label="Toggle translated captions"
                  >
                    <span />
                  </button>
                </div>
                <div className="settings-row">
                  <div>
                    <b>Target language</b>
                    <small>{targetLanguage}</small>
                  </div>
                  <button className="text-button" onClick={() => setActivePanel("translate")}>
                    Change
                  </button>
                </div>
                {[
                  ["audioinput", "Microphone"],
                  ["videoinput", "Camera"],
                  ["audiooutput", "Speaker"],
                ].map(
                  ([kind, label]) =>
                    devices[kind]?.length > 0 && (
                      <div className="settings-row" key={kind} style={{ display: "block" }}>
                        <b>{label}</b>
                        <select
                          className="dark-select settings-select"
                          aria-label={label}
                          value={activeDevices[kind] || ""}
                          onChange={(e) => meeting.switchDevice(kind, e.target.value)}
                        >
                          {devices[kind].map((device, index) => (
                            <option key={device.deviceId} value={device.deviceId}>
                              {device.label || `${label} ${index + 1}`}
                            </option>
                          ))}
                        </select>
                      </div>
                    ),
                )}
                <div className="settings-row">
                  <div>
                    <b>Room ID</b>
                    <small>{roomId}</small>
                  </div>
                  <button className="text-button" onClick={copyInvite}>
                    {copied ? "Copied" : "Copy link"}
                  </button>
                </div>
              </div>
            )}
          </aside>
        )}
      </div>
    </main>
  );
}
