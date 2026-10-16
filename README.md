# Meetown

Meetown is a self-hostable real-time meeting prototype built with React, Vite, Node.js, Socket.IO, WebRTC, and mediasoup.

## Repository structure

```text
tp/
├── client/
│   ├── public/                 # Static assets
│   └── src/
│       ├── components/
│       │   ├── captions/       # Caption panel and in-call caption overlay
│       │   └── meeting/        # Meeting-specific UI components
│       ├── constants/          # Shared frontend constants
│       ├── hooks/              # Reusable React state and event logic
│       ├── services/           # Client-side service adapters (next step)
│       ├── styles/             # Product design system and app styling
│       ├── App.jsx             # App-level composition and call lifecycle
│       ├── index.css           # Global reset and accessibility defaults
│       └── main.jsx            # React entry point
├── server/
│   └── src/
│       └── server.js           # HTTP API, Socket.IO signaling, mediasoup
└── caption-worker/
    ├── main.py                 # Self-hosted speech recognition + translation
    ├── requirements.txt
    └── README.md
```

## Run locally

1. Install a current supported Node.js LTS release.
2. In `client/`, run `npm ci`, copy `.env.example` to `.env`, then run `npm run dev`.
3. In `server/`, run `npm ci`, copy `.env.example` to `.env`, then run `npm run dev`.
4. Configure the server's public IP and mediasoup UDP port range before testing between different networks.

## Caption feature status

The frontend now has:

- Source-language and target-language controls.
- An accessible on-stage caption overlay.
- A scrollable caption transcript with speaker labels and timestamps.
- A sample-caption action to review the UI without a speech service.
- A `useLiveCaptions` hook that listens for the Socket.IO event `caption:result`.

**Live caption pipeline is now wired as an initial implementation.** The browser captures the local microphone in short PCM chunks only while captions are enabled and the microphone is unmuted. The Node signaling server forwards those chunks to the self-hosted Python worker, which uses faster-whisper for speech recognition and locally installed Argos Translate packages for translation. The server sends a translated caption to each participant based on that participant's target language. The sample-caption button remains a UI preview. This is an early implementation and needs integration/performance/security testing before production use.

### Caption event contract

```js
{
  id: "unique-caption-segment-id",
  speakerId: "socket-peer-id",
  speakerName: "Participant",
  sourceLanguage: "German",
  targetLanguage: "English",
  originalText: "Guten Morgen zusammen.",
  translatedText: "Good morning everyone.",
  isFinal: true,
  timestamp: 1791972000000
}
```

The event name is `caption:result`. The Node server emits this event after receiving worker output. Do not accept arbitrary client-generated caption text as trusted server output in production.

## Current limitations

- The app is still a prototype. Authentication, authorization, production deployment hardening, and comprehensive reconnect handling remain future work.
- Chat and notes are local UI prototypes; they are not yet synchronized through the server.
- The caption worker must be started separately. Install the Argos language packages required for each translation pair (`python install_argos_pairs.py de-en en-de` from `caption-worker/` is an example); unsupported pairs show the original transcript without pretending it was translated.
- Current audio chunking is prototype-grade: four-second chunks, one in-flight transcription per speaker, and simple resampling. Latency, dropped audio under slow inference, voice activity detection, and multilingual overlap need testing.
- Caption audio is transmitted to your own worker, so it is not end-to-end private from the server operator. Add explicit consent and secure networking before production deployment.

## Run the caption worker

See `caption-worker/README.md`. Start the worker on `127.0.0.1:8010`, and keep it private. Install the needed Argos Translate language packages for each source/target pair. The Node server uses `CAPTION_WORKER_URL` from `server/.env`.
