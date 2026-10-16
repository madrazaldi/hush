// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
export const ssr = false;

export const load = async () => {
  // Outside Tauri (plain browser during development) fake the IPC layer.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    (await import("#lib/devmock/index.js")).install();
  }
};
