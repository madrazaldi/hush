import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import adapter from "@sveltejs/adapter-static";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    sveltekit({
      // The app is a client-only SPA shown in an Electrobun window: adapter-static with a fallback to
      // index.html (https://svelte.dev/docs/kit/single-page-apps). `dist/` is copied into the app bundle
      // by electrobun.config.ts (`build/` is Electrobun's own output folder).
      adapter: adapter({ pages: "dist", assets: "dist", fallback: "index.html" }),
    }),
  ],

  // Keep Vite from obscuring build errors.
  clearScreen: false,
  // `bun run dev` serves the UI (backed by src/lib/devmock) on a fixed port; the Electrobun dev shell
  // also finds it there.
  server: {
    port: 1427,
    strictPort: true,
    host: "127.0.0.1",
  },
});
