// Backend -> UI events (the old Tauri `emit`). The shell registers one sink per window.

export type EventSink = (event: string, payload: unknown) => void;

const sinks = new Set<EventSink>();

/** Subscribe to every event. Returns an unsubscribe function. */
export function onEvent(sink: EventSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

export function emit(event: string, payload: unknown = null): void {
  for (const sink of sinks) {
    try {
      sink(event, payload);
    } catch {
      // a window that is going away must not break the backend
    }
  }
}
