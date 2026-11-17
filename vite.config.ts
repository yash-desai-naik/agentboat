import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and serves the built files from ../dist.
// 1422, so Ccboat can run in dev next to Fileboat/Tableboat (1420) and Agentsboat (1421).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1422,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // WebView2 is evergreen Chromium, so modern output is safe and smaller.
    target: "chrome120",
    sourcemap: false,
  },
});
