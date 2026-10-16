import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const certDir = path.resolve(__dirname, "certs");
const keyPath = path.join(certDir, "192.168.188.26+2-key.pem");
const certPath = path.join(certDir, "192.168.188.26+2.pem");
const hasLocalCertificate = fs.existsSync(keyPath) && fs.existsSync(certPath);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    ...(hasLocalCertificate
      ? { https: { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) } }
      : {}),
    proxy: {
      "/socket.io": {
        target: "http://127.0.0.1:3003",
        ws: true,
        changeOrigin: false,
      },
    },
  },
});
