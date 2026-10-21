import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { Room, RoomEvent, Track, VideoPresets } from "livekit-client";
import { API_BASE, fetchJoinToken } from "../services/api.js";
import { request } from "../services/signaling.js";

// One MediaStream per MediaStreamTrack, so <video> elements are not re-attached on every update.
const streamCache = new WeakMap();
function streamFor(mediaTrack) {
  let stream = streamCache.get(mediaTrack);
  if (!stream) {
    stream = new MediaStream([mediaTrack]);
    streamCache.set(mediaTrack, stream);
  }
  return stream;
}

function buildTiles(room) {
  const tiles = [];
  for (const p of [room.localParticipant, ...room.remoteParticipants.values()]) {
    const cam = p.getTrackPublication(Track.Source.Camera);
    const mic = p.getTrackPublication(Track.Source.Microphone);
    const screen = p.getTrackPublication(Track.Source.ScreenShare);
    const camTrack = cam?.track?.mediaStreamTrack;
    const hasVideo = Boolean(camTrack) && !cam.isMuted;
    const name = p.name || "Participant";
    tiles.push({
      peerId: p.identity,
      name,
      local: p.isLocal,
      stream: hasVideo ? streamFor(camTrack) : null,
      hasVideo,
      micMuted: !mic || mic.isMuted,
      speaking: p.isSpeaking,
      quality: p.connectionQuality,
      screen: false,
    });
    const screenTrack = screen?.track?.mediaStreamTrack;
    if (screenTrack) {
      tiles.push({
        peerId: `${p.identity}:screen`,
        name: `${name} · screen`,
        local: p.isLocal,
        stream: streamFor(screenTrack),
        hasVideo: true,
        micMuted: false,
        speaking: false,
        quality: p.connectionQuality,
        screen: true,
      });
    }
  }
  return tiles;
}

function friendlyMediaError(error, what) {
  switch (error?.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return `${what} permission was denied. Allow it in your browser's site settings, then toggle it on.`;
    case "NotFoundError":
      return `No ${what.toLowerCase()} was found on this device.`;
    case "NotReadableError":
      return `${what} is in use by another app or tab.`;
    default:
      return `${what} could not be started: ${error?.message || "unknown error"}`;
  }
}

function mergeMessages(current, incoming) {
  const seen = new Set(current.map((m) => m.id));
  const added = incoming.filter((m) => !seen.has(m.id));
  return added.length ? [...current, ...added].slice(-300) : current;
}

export function useMeeting() {
  const [connection, setConnection] = useState("idle"); // idle|connecting|connected|reconnecting|disconnected
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tiles, setTiles] = useState([]);
  const [localAudioStream, setLocalAudioStream] = useState(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [devices, setDevices] = useState({ audioinput: [], videoinput: [], audiooutput: [] });
  const [activeDevices, setActiveDevices] = useState({});
  const [socket, setSocket] = useState(null);
  const [socketEpoch, setSocketEpoch] = useState(0);
  const [chatMessages, setChatMessages] = useState([]);
  const [persistence, setPersistence] = useState("");
  const [notes, setNotesValue] = useState("");
  const [notesState, setNotesState] = useState("local");
  const [me, setMe] = useState({ identity: "", name: "" });

  const roomRef = useRef(null);
  const socketRef = useRef(null);
  const audioHostRef = useRef(null);
  const leavingRef = useRef(false);
  const lastJoinRef = useRef(null);
  const notesTimerRef = useRef(null);
  const lastNotesEditRef = useRef(0);

  const refresh = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    setTiles(buildTiles(room));
    const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const micTrack = mic?.track?.mediaStreamTrack;
    setLocalAudioStream(micTrack ? streamFor(micTrack) : null);
  }, []);

  const refreshDevices = useCallback(async () => {
    const room = roomRef.current;
    const kinds = ["audioinput", "videoinput", "audiooutput"];
    const lists = await Promise.all(
      kinds.map((kind) => Room.getLocalDevices(kind, false).catch(() => [])),
    );
    setDevices(Object.fromEntries(kinds.map((kind, i) => [kind, lists[i]])));
    if (room) {
      setActiveDevices(
        Object.fromEntries(kinds.map((kind) => [kind, room.getActiveDevice(kind) || ""])),
      );
    }
  }, []);

  const teardown = useCallback(() => {
    leavingRef.current = true;
    clearTimeout(notesTimerRef.current);
    const socketInstance = socketRef.current;
    if (socketInstance) {
      socketInstance.emit("leave-room");
      socketInstance.disconnect();
    }
    socketRef.current = null;
    roomRef.current?.disconnect(true); // true = stop camera/mic tracks
    roomRef.current = null;
    audioHostRef.current?.remove();
    audioHostRef.current = null;
  }, []);

  const connectSocket = useCallback((token) => {
    const instance = io(API_BASE || undefined, {
      transports: ["websocket", "polling"],
      reconnection: true,
      timeout: 10000,
    });
    socketRef.current = instance;
    setSocket(instance);

    instance.on("chat:message", (message) =>
      setChatMessages((current) => mergeMessages(current, [message])),
    );
    instance.on("notes:updated", ({ content }) => {
      // Don't overwrite what this user is typing right now.
      if (Date.now() - lastNotesEditRef.current > 2500) {
        setNotesValue(content);
        setNotesState("saved");
      }
    });

    return new Promise((resolve, reject) => {
      let first = true;
      const timer = setTimeout(
        () => reject(new Error("The chat and captions service is unreachable.")),
        10000,
      );
      // Runs on the first connect and again after every automatic reconnect.
      instance.on("connect", async () => {
        try {
          const res = await request(instance, "join-room", { token });
          setChatMessages((current) => mergeMessages(current, res.history.messages));
          setPersistence(res.history.persistence);
          if (!lastNotesEditRef.current) setNotesValue(res.history.notes || "");
          if (res.history.notes && !lastNotesEditRef.current) setNotesState("saved");
          setSocketEpoch((n) => n + 1);
          if (first) {
            first = false;
            clearTimeout(timer);
            resolve();
          }
        } catch (joinError) {
          if (first) {
            first = false;
            clearTimeout(timer);
            reject(joinError);
          } else {
            setNotice(joinError.message);
          }
        }
      });
      instance.on("connect_error", () => {
        if (first) {
          first = false;
          clearTimeout(timer);
          reject(new Error("The chat and captions service is unreachable."));
        }
      });
    });
  }, []);

  const join = useCallback(
    async ({ roomId, name }) => {
      lastJoinRef.current = { roomId, name };
      leavingRef.current = false;
      setError("");
      setNotice("");
      setConnection("connecting");
      try {
        if (!roomId.trim() || !name.trim()) throw new Error("Enter your name and a meeting ID.");
        const info = await fetchJoinToken(roomId.trim(), name.trim());
        setMe({ identity: info.identity, name: info.name });

        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
          videoCaptureDefaults: { resolution: VideoPresets.h540.resolution },
          audioCaptureDefaults: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          publishDefaults: {
            simulcast: true,
            videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
          },
        });
        roomRef.current = room;

        const host = document.createElement("div");
        host.style.display = "none";
        document.body.appendChild(host);
        audioHostRef.current = host;

        room
          .on(RoomEvent.TrackSubscribed, (track) => {
            if (track.kind === Track.Kind.Audio) host.appendChild(track.attach());
            refresh();
          })
          .on(RoomEvent.TrackUnsubscribed, (track) => {
            track.detach().forEach((element) => element.remove());
            refresh();
          })
          .on(RoomEvent.AudioPlaybackStatusChanged, () => setAudioBlocked(!room.canPlaybackAudio))
          .on(RoomEvent.Reconnecting, () => setConnection("reconnecting"))
          .on(RoomEvent.Reconnected, () => {
            setConnection("connected");
            refresh();
          })
          .on(RoomEvent.Disconnected, () => {
            if (leavingRef.current) return;
            setConnection("disconnected");
            setError("You were disconnected from the meeting.");
          })
          .on(RoomEvent.MediaDevicesChanged, refreshDevices)
          .on(RoomEvent.MediaDevicesError, (e) =>
            setNotice(friendlyMediaError(e, "Camera or microphone")),
          );
        for (const event of [
          RoomEvent.ParticipantConnected,
          RoomEvent.ParticipantDisconnected,
          RoomEvent.TrackMuted,
          RoomEvent.TrackUnmuted,
          RoomEvent.TrackPublished,
          RoomEvent.TrackUnpublished,
          RoomEvent.LocalTrackPublished,
          RoomEvent.LocalTrackUnpublished,
          RoomEvent.ActiveSpeakersChanged,
          RoomEvent.ConnectionQualityChanged,
          RoomEvent.ParticipantNameChanged,
        ]) {
          room.on(event, refresh);
        }

        // Media and the chat socket connect in parallel; a socket failure must not block the call.
        const socketReady = connectSocket(info.token).catch((socketError) =>
          setNotice(`${socketError.message} Video and audio still work; chat and captions are off.`),
        );
        try {
          await room.connect(info.url, info.token);
        } catch (connectError) {
          throw new Error(
            `Could not reach the media server (${connectError.message}). Check your network and try again.`,
            { cause: connectError },
          );
        }

        // Ask for camera + microphone in one prompt; degrade gracefully if refused.
        if (!navigator.mediaDevices?.getUserMedia) {
          setNotice("Camera and microphone need a secure (HTTPS) connection. You joined as a viewer.");
        } else {
          try {
            await room.localParticipant.enableCameraAndMicrophone();
          } catch {
            const problems = [];
            try {
              await room.localParticipant.setMicrophoneEnabled(true);
            } catch (micError) {
              problems.push(friendlyMediaError(micError, "Microphone"));
            }
            try {
              await room.localParticipant.setCameraEnabled(true);
            } catch (camError) {
              problems.push(friendlyMediaError(camError, "Camera"));
            }
            if (problems.length) setNotice(problems.join(" "));
          }
        }
        setAudioBlocked(!room.canPlaybackAudio);
        setConnection("connected");
        refresh();
        refreshDevices();
        await socketReady;
      } catch (joinError) {
        teardown();
        setSocket(null);
        setTiles([]);
        setConnection("idle");
        setError(joinError.message || "Unable to join the meeting.");
      }
    },
    [connectSocket, refresh, refreshDevices, teardown],
  );

  const resetState = useCallback(() => {
    setConnection("idle");
    setTiles([]);
    setSocket(null);
    setLocalAudioStream(null);
    setChatMessages([]);
    setNotesValue("");
    setNotesState("local");
    setAudioBlocked(false);
    setNotice("");
    setError("");
    lastNotesEditRef.current = 0;
  }, []);

  const leave = useCallback(() => {
    teardown();
    resetState();
  }, [teardown, resetState]);

  const rejoin = useCallback(() => {
    const last = lastJoinRef.current;
    teardown();
    if (last) join(last);
  }, [teardown, join]);

  useEffect(() => teardown, [teardown]);

  /* ------------------------------ controls ------------------------------ */

  const run = useCallback(async (action, what) => {
    try {
      await action(roomRef.current.localParticipant);
    } catch (e) {
      setNotice(friendlyMediaError(e, what));
    }
    refresh();
    refreshDevices();
  }, [refresh, refreshDevices]);

  const toggleMicrophone = useCallback(
    () => run((lp) => lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled), "Microphone"),
    [run],
  );
  const toggleCamera = useCallback(
    () => run((lp) => lp.setCameraEnabled(!lp.isCameraEnabled), "Camera"),
    [run],
  );
  const toggleScreenShare = useCallback(
    () => run((lp) => lp.setScreenShareEnabled(!lp.isScreenShareEnabled), "Screen sharing"),
    [run],
  );

  const switchDevice = useCallback(async (kind, deviceId) => {
    try {
      await roomRef.current.switchActiveDevice(kind, deviceId);
      setActiveDevices((current) => ({ ...current, [kind]: deviceId }));
    } catch (e) {
      setNotice(`Could not switch device: ${e.message}`);
    }
  }, []);

  const startAudio = useCallback(async () => {
    await roomRef.current?.startAudio();
    setAudioBlocked(!roomRef.current?.canPlaybackAudio);
  }, []);

  const sendChat = useCallback(async (text) => {
    await request(socketRef.current, "chat:send", { text });
  }, []);

  const setNotes = useCallback((value) => {
    setNotesValue(value);
    setNotesState("saving");
    lastNotesEditRef.current = Date.now();
    clearTimeout(notesTimerRef.current);
    notesTimerRef.current = setTimeout(async () => {
      try {
        await request(socketRef.current, "notes:update", { content: value });
        setNotesState("saved");
      } catch {
        setNotesState("error");
      }
    }, 700);
  }, []);

  return {
    connection,
    joined: ["connected", "reconnecting", "disconnected"].includes(connection),
    joining: connection === "connecting",
    error,
    notice,
    dismissNotice: () => setNotice(""),
    tiles,
    me,
    localAudioStream,
    audioBlocked,
    devices,
    activeDevices,
    socket,
    socketEpoch,
    chatMessages,
    persistence,
    notes,
    notesState,
    join,
    leave,
    rejoin,
    toggleMicrophone,
    toggleCamera,
    toggleScreenShare,
    switchDevice,
    startAudio,
    sendChat,
    setNotes,
  };
}
