import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import * as mediasoupClient from "mediasoup-client";
import VideoTile from "./components/meeting/VideoTile.jsx";
import LiveCaptionOverlay from "./components/captions/LiveCaptionOverlay.jsx";
import CaptionPanel from "./components/captions/CaptionPanel.jsx";
import { useLiveCaptions } from "./hooks/useLiveCaptions.js";
import { useCaptionAudio } from "./hooks/useCaptionAudio.js";
import { request } from "./services/signaling.js";

function getSignalingUrl() {
  // Same-origin connection: Vite proxies /socket.io to the local Node server.
  // This avoids localhost pointing at the phone and avoids HTTPS mixed content.
  return window.location.origin;
}

export default function App() {
  const [roomId, setRoomId] = useState("team-meeting");
  const [name, setName] = useState("Guest");
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [activePanel, setActivePanel] = useState("translate");
  const [targetLanguage, setTargetLanguage] = useState("English");
  const [sourceLanguage, setSourceLanguage] = useState("auto");
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [meetingSocket, setMeetingSocket] = useState(null);
  const localStreamRef = useRef(null);

  const {
    captions,
    connectionState: captionConnectionState,
    addPreviewCaption,
    clearCaptions,
  } = useLiveCaptions({
    socket: meetingSocket,
    enabled: joined && captionsEnabled,
    targetLanguage,
    sourceLanguage,
  });
  useCaptionAudio({
    stream: joined ? localStreamRef.current : null,
    socket: meetingSocket,
    enabled: joined && captionsEnabled && !muted,
    sourceLanguage,
    targetLanguage,
  });
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [meetingNotes, setMeetingNotes] = useState("");

  const socketRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);
  const producersRef = useRef([]);
  const consumersRef = useRef(new Map());
  const streamsRef = useRef(new Map());
  const deviceRef = useRef(null);
  const activeRef = useRef(false);
  const pendingRef = useRef([]);
  const producerPeersRef = useRef(new Map());
  const consumedProducerIdsRef = useRef(new Set());

  function addParticipant(peerId, participantName, stream, local = false) {
    setParticipants((current) => {
      const index = current.findIndex((p) => p.peerId === peerId);
      const entry = {
        peerId,
        name: participantName,
        stream,
        local,
      };

      if (index >= 0) {
        const next = [...current];
        next[index] = entry;
        return next;
      }

      return [...current, entry];
    });
  }

  function removeParticipant(peerId) {
    setParticipants((current) => current.filter((p) => p.peerId !== peerId));
  }

  async function consumeProducer(info) {
    const socket = socketRef.current;
    const transport = recvTransportRef.current;
    const device = deviceRef.current;

    // This function runs in response to a media event,
    // not during React rendering.
    if (!activeRef.current || !transport || !device) {
      pendingRef.current.push(info);
      return;
    }

    // Prevent duplicate consumers for the same producer.
    if (consumedProducerIdsRef.current.has(info.producerId)) {
      return;
    }

    consumedProducerIdsRef.current.add(info.producerId);
    producerPeersRef.current.set(info.producerId, info.peerId);

    try {
      const params = await request(socket, "consume", {
        transportId: transport.id,
        producerId: info.producerId,
      });

      const consumer = await transport.consume(params);
      consumersRef.current.set(consumer.id, consumer);

      let stream = streamsRef.current.get(info.peerId);

      if (!stream) {
        stream = new MediaStream();
        streamsRef.current.set(info.peerId, stream);
      }

      stream.addTrack(consumer.track);

      addParticipant(info.peerId, info.name || "Participant", stream);

      await request(socket, "resume-consumer", {
        consumerId: consumer.id,
      });
    } catch (error) {
      // Allow retry if creating the consumer failed.
      consumedProducerIdsRef.current.delete(info.producerId);
      producerPeersRef.current.delete(info.producerId);
      throw error;
    }
  }

  async function joinMeeting() {
    try {
      setError("");

      if (!roomId.trim() || !name.trim()) {
        throw new Error("Enter your name and a meeting ID.");
      }

      const socket = io(getSignalingUrl(), {
        transports: ["websocket", "polling"],
        timeout: 10000,
        reconnection: true,
      });
      socketRef.current = socket;
      setMeetingSocket(socket);

      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("connect_error", (connectionError) => {
          reject(
            new Error(
              `Cannot connect to Meetown signaling server at ${getSignalingUrl()}: ${connectionError.message}. Check server/.env, Windows Firewall, and that your phone and PC are on the same Wi-Fi.`,
            ),
          );
        });
      });

      const room = await request(socket, "join-room", {
        roomId: roomId.trim(),
        name: name.trim(),
      });

      const device = new mediasoupClient.Device();
      await device.load({
        routerRtpCapabilities: room.routerRtpCapabilities,
      });

      deviceRef.current = device;

      await request(socket, "set-rtp-capabilities", {
        rtpCapabilities: device.rtpCapabilities,
      });

      // Ask the browser for local audio and video.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: { ideal: 24, max: 30 },
        },
      });

      localStreamRef.current = stream;
      addParticipant(socket.id, name.trim(), stream, true);

      // Create the outgoing media transport.
      const sendParams = await request(socket, "create-transport");
      const sendTransport = device.createSendTransport(sendParams);
      sendTransportRef.current = sendTransport;

      sendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
        request(socket, "connect-transport", {
          transportId: sendTransport.id,
          dtlsParameters,
        })
          .then(callback)
          .catch(errback);
      });

      sendTransport.on(
        "produce",
        ({ kind, rtpParameters }, callback, errback) => {
          request(socket, "produce", {
            transportId: sendTransport.id,
            kind,
            rtpParameters,
          })
            .then(({ id }) => callback({ id }))
            .catch(errback);
        },
      );

      // Create the incoming media transport.
      const recvParams = await request(socket, "create-transport");
      const recvTransport = device.createRecvTransport(recvParams);
      recvTransportRef.current = recvTransport;

      recvTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
        request(socket, "connect-transport", {
          transportId: recvTransport.id,
          dtlsParameters,
        })
          .then(callback)
          .catch(errback);
      });

      // Publish local audio and video.
      for (const track of stream.getTracks()) {
        const producer = await sendTransport.produce({ track });
        producersRef.current.push(producer);
      }

      activeRef.current = true;
      setJoined(true);

      socket.on("new-producer", (info) => {
        consumeProducer(info).catch((err) => {
          console.error("Unable to receive media:", err);
          setError(err.message);
        });
      });

      socket.on("peer-left", ({ peerId }) => {
        const stream = streamsRef.current.get(peerId);
        stream?.getTracks().forEach((track) => track.stop());
        streamsRef.current.delete(peerId);

        for (const [id, consumer] of consumersRef.current) {
          if (producerPeersRef.current.get(consumer.producerId) === peerId) {
            consumer.close();
            consumersRef.current.delete(id);
            consumedProducerIdsRef.current.delete(consumer.producerId);
            producerPeersRef.current.delete(consumer.producerId);
          }
        }
        removeParticipant(peerId);
      });

      for (const producer of room.existingProducers) {
        await consumeProducer(producer);
      }

      for (const info of pendingRef.current.splice(0)) {
        await consumeProducer(info);
      }
    } catch (err) {
      setError(err.message || "Unable to join the meeting.");
      console.error(err);
    }
  }

  function toggleMicrophone() {
    const track = localStreamRef.current?.getAudioTracks()[0];

    if (track) {
      track.enabled = !track.enabled;
      setMuted(!track.enabled);
    }
  }

  function toggleCamera() {
    const track = localStreamRef.current?.getVideoTracks()[0];

    if (track) {
      track.enabled = !track.enabled;
      setCameraOff(!track.enabled);
    }
  }

  function leaveMeeting() {
    activeRef.current = false;

    producersRef.current.forEach((p) => p.close());
    consumersRef.current.forEach((c) => c.close());
    sendTransportRef.current?.close();
    recvTransportRef.current?.close();

    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));

    socketRef.current?.disconnect();

    socketRef.current = null;
    setMeetingSocket(null);
    localStreamRef.current = null;
    sendTransportRef.current = null;
    recvTransportRef.current = null;
    producersRef.current = [];
    consumersRef.current.clear();
    streamsRef.current.clear();
    pendingRef.current = [];
    producerPeersRef.current.clear();
    consumedProducerIdsRef.current.clear();

    setParticipants([]);
    setJoined(false);
    setMuted(false);
    setCameraOff(false);
  }

  useEffect(() => {
    return () => {
      activeRef.current = false;
      socketRef.current?.disconnect();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      sendTransportRef.current?.close();
      recvTransportRef.current?.close();
    };
  }, []);

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
                    required
                  />
                </div>
                <button className="primary-button" type="submit">
                  <span>Join meeting</span>
                  <span className="button-arrow">↗</span>
                </button>
                {error && (
                  <p className="error" role="alert">
                    {error}
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
                      Live translated captions are on our roadmap — designed for
                      conversations across languages.
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

  const sendLocalMessage = (event) => {
    event.preventDefault();
    if (!chatDraft.trim()) return;
    setChatMessages((items) => [
      ...items,
      { id: Date.now(), name: name || "You", text: chatDraft.trim() },
    ]);
    setChatDraft("");
  };

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
        <div className="meeting-title">
          <strong>{roomId}</strong>
          <span>
            <i className="footer-dot" /> Room is active
          </span>
        </div>
        <div className="meeting-top-actions">
          <span className="encrypted-label">
            ◇ <span>Private room</span>
          </span>
          <button
            className="icon-button"
            title="Meeting settings"
            onClick={() => setActivePanel("settings")}
          >
            ⚙
          </button>
          <div className="avatar-mini">
            {(name || "G").slice(0, 1).toUpperCase()}
          </div>
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
            <div className="participant-count">
              <span className="participant-count-icon">♙</span>
              {participants.length} <span>participants</span>
            </div>
          </div>
          <section
            className={`video-grid participant-count-${Math.min(participants.length, 4)}`}
          >
            {participants.map((p, index) => (
              <div
                className={`video-tile ${p.local ? "local-tile" : ""}`}
                key={p.peerId}
              >
                <VideoTile stream={p.stream} name={p.name} muted={p.local} />
                <span className="tile-presence">
                  <i /> {p.local ? "You" : "Connected"}
                </span>
              </div>
            ))}
            {participants.length === 0 && (
              <div className="empty-stage">
                <div className="empty-orb">✦</div>
                <h3>Getting your space ready</h3>
                <p>Your meeting tiles will appear here.</p>
              </div>
            )}
          </section>
          <LiveCaptionOverlay captions={captions} enabled={captionsEnabled} />
          {error && (
            <p className="error meeting-error" role="alert">
              {error}
            </p>
          )}
          <div className="call-toolbar-wrap">
            <div className="call-toolbar">
              <button
                className={`control-button ${muted ? "control-off" : ""}`}
                onClick={toggleMicrophone}
              >
                <span className="control-glyph">{muted ? "♩̸" : "♩"}</span>
                <span>{muted ? "Unmute" : "Mute"}</span>
              </button>
              <button
                className={`control-button ${cameraOff ? "control-off" : ""}`}
                onClick={toggleCamera}
              >
                <span className="control-glyph">{cameraOff ? "▣" : "▣"}</span>
                <span>{cameraOff ? "Start video" : "Stop video"}</span>
              </button>
              <button
                className={`control-button ${activePanel === "translate" ? "control-selected" : ""}`}
                onClick={() =>
                  setActivePanel(activePanel === "translate" ? "" : "translate")
                }
              >
                <span className="control-glyph">文</span>
                <span>Translate</span>
              </button>
              <button
                className={`control-button ${activePanel === "chat" ? "control-selected" : ""}`}
                onClick={() =>
                  setActivePanel(activePanel === "chat" ? "" : "chat")
                }
              >
                <span className="control-glyph">▤</span>
                <span>Chat</span>
              </button>
              <button
                className={`control-button ${activePanel === "notes" ? "control-selected" : ""}`}
                onClick={() =>
                  setActivePanel(activePanel === "notes" ? "" : "notes")
                }
              >
                <span className="control-glyph">✎</span>
                <span>Notes</span>
              </button>
              <span className="toolbar-separator" />
              <button className="leave-button" onClick={leaveMeeting}>
                <span>↗</span> Leave
              </button>
            </div>
            <div className="toolbar-hint">
              <span className="shortcut-key">⌘</span> Tip: choose Translate to
              configure your caption language
            </div>
          </div>
        </section>
        {activePanel && (
          <aside className="meeting-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">MEETING TOOLS</span>
                <h2>
                  {activePanel === "translate"
                    ? "Live translate"
                    : activePanel === "chat"
                      ? "Meeting chat"
                      : activePanel === "notes"
                        ? "Shared notes"
                        : "Settings"}
                </h2>
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
              <button
                className={activePanel === "translate" ? "active" : ""}
                onClick={() => setActivePanel("translate")}
              >
                Translate
              </button>
              <button
                className={activePanel === "chat" ? "active" : ""}
                onClick={() => setActivePanel("chat")}
              >
                Chat
              </button>
              <button
                className={activePanel === "notes" ? "active" : ""}
                onClick={() => setActivePanel("notes")}
              >
                Notes
              </button>
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
                      <p>
                        Send a message to try the chat interface. Server-synced
                        chat will be wired in a later step.
                      </p>
                    </div>
                  ) : (
                    chatMessages.map((message) => (
                      <div className="chat-message" key={message.id}>
                        <span className="chat-message-avatar">
                          {message.name.slice(0, 1).toUpperCase()}
                        </span>
                        <div>
                          <b>{message.name}</b>
                          <p>{message.text}</p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <form className="chat-compose" onSubmit={sendLocalMessage}>
                  <input
                    value={chatDraft}
                    onChange={(e) => setChatDraft(e.target.value)}
                    placeholder="Write a message…"
                    aria-label="Write a message"
                  />
                  <button type="submit" aria-label="Send message">
                    ↗
                  </button>
                </form>
                <p className="panel-disclaimer">
                  Prototype: messages currently stay in this browser session.
                </p>
              </div>
            )}
            {activePanel === "notes" && (
              <div className="panel-content notes-panel">
                <div className="notes-toolbar">
                  <span>✎ &nbsp;Team notes</span>
                  <span className="saved-label">
                    <i /> Local draft
                  </span>
                </div>
                <textarea
                  value={meetingNotes}
                  onChange={(e) => setMeetingNotes(e.target.value)}
                  placeholder={
                    "Capture decisions, ideas, and action items…\n\n• Decision:\n• Owner:\n• Next step:"
                  }
                />
                <div className="notes-footnote">
                  Notes are a local UI draft for now. Shared persistence and
                  live collaboration come next.
                </div>
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
                  >
                    <span />
                  </button>
                </div>
                <div className="settings-row">
                  <div>
                    <b>Target language</b>
                    <small>{targetLanguage}</small>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setActivePanel("translate")}
                  >
                    Change
                  </button>
                </div>
                <div className="settings-row">
                  <div>
                    <b>Room ID</b>
                    <small>{roomId}</small>
                  </div>
                </div>
                <p className="panel-disclaimer">
                  More audio, video, and privacy controls will be added in later
                  phases.
                </p>
              </div>
            )}
          </aside>
        )}
      </div>
    </main>
  );
}
