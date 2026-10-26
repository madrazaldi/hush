// The app is a client-only SPA shown in an Electrobun window, so there is no server-side rendering:
// adapter-static builds it with a fallback to index.html (see svelte.config.js).
// See: https://svelte.dev/docs/kit/single-page-apps
export const ssr = false;

export const load = async () => {
  // In a plain browser during development (`bun run dev`) there is no Electrobun shell: fake the backend.
  if (import.meta.env.DEV && !("__electrobun" in window)) {
    (await import("#lib/devmock/index.js")).install();
  }
};
