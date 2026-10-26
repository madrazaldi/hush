// Tiny leveled logger. Everything goes to stderr so stdout stays free for tools that pipe it.

const ts = () => new Date().toISOString().slice(11, 23);

function line(level: string, args: unknown[]) {
  const msg = args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.error(`${ts()} ${level} ${msg}`);
}

export const log = {
  debug: (...args: unknown[]) => {
    if (process.env.HUSH_DEBUG) line("DEBUG", args);
  },
  info: (...args: unknown[]) => line("INFO ", args),
  warn: (...args: unknown[]) => line("WARN ", args),
  error: (...args: unknown[]) => line("ERROR", args),
};

/** Message text of anything thrown. */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
