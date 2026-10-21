import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Phones need HTTPS for camera/microphone. Generate a local certificate with
// `mkcert <your-LAN-ip> localhost`, put the two .pem files in client/certs/ and
// name them certs/dev-key.pem and certs/dev-cert.pem. Never commit them.
const keyPath = path.join(__dirname, "certs", "dev-key.pem");
const certPath = path.join(__dirname, "certs", "dev-cert.pem");
const https =
  fs.existsSync(keyPath) && fs.existsSync(certPath)
    ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
    : undefined;

const api = "http://127.0.0.1:3003";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    https,
    proxy: {
      "/api": { target: api, changeOrigin: false },
      "/socket.io": { target: api, ws: true, changeOrigin: false },
    },
  },
});
