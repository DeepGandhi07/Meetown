# Meetown client

Install dependencies with `npm ci`. Copy `.env.example` to `.env` (the signaling URL can remain blank). Run `npm run dev -- --host 0.0.0.0` to make Vite reachable from a phone on the same Wi-Fi. Open the Vite Network URL printed in the terminal. The server must be configured with `ANNOUNCED_IP` set to the PC's Wi-Fi IPv4 address for mediasoup media to work over the LAN.
