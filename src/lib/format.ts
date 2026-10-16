export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? h + ":" : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60 ? (m % 60) + "m" : ""}`.trim();
}

export function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

export function relDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const day = 86_400_000;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (startOf(now) - startOf(d)) / day;
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Yesterday, ${time}`;
  if (diff < 7) return `${d.toLocaleDateString([], { weekday: "long" })}, ${time}`;
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

export function dayGroup(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], {
    month: "long",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

export function groupBy<T>(items: T[], key: (t: T) => string): [string, T[]][] {
  const out: [string, T[]][] = [];
  for (const it of items) {
    const k = key(it);
    const last = out[out.length - 1];
    if (last && last[0] === k) last[1].push(it);
    else out.push([k, [it]]);
  }
  return out;
}

export function words(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** Render a hotkey string ("Cmd+Shift+Space") as macOS glyphs. */
export function keyGlyphs(hotkey: string): string[] {
  const map: Record<string, string> = {
    cmd: "⌘",
    command: "⌘",
    super: "⌘",
    ctrl: "⌃",
    control: "⌃",
    alt: "⌥",
    option: "⌥",
    opt: "⌥",
    shift: "⇧",
    fn: "fn",
    cmdright: "right ⌘",
    optright: "right ⌥",
    ctrlright: "right ⌃",
    shiftright: "right ⇧",
    cmdleft: "left ⌘",
    optleft: "left ⌥",
    ctrlleft: "left ⌃",
    shiftleft: "left ⇧",
    space: "Space",
    enter: "↩",
    return: "↩",
    escape: "esc",
    esc: "esc",
    tab: "⇥",
    backspace: "⌫",
    delete: "⌫",
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
  };
  return hotkey
    .split("+")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => map[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k));
}

export const LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["tr", "Turkish"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["id", "Indonesian"],
  ["ms", "Malay"],
  ["vi", "Vietnamese"],
  ["th", "Thai"],
  ["zh", "Chinese"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["sv", "Swedish"],
  ["da", "Danish"],
  ["no", "Norwegian"],
  ["fi", "Finnish"],
  ["cs", "Czech"],
  ["el", "Greek"],
  ["he", "Hebrew"],
  ["hu", "Hungarian"],
  ["ro", "Romanian"],
];

export function languageName(code: string | null | undefined): string {
  if (!code) return "Auto-detect";
  return LANGUAGES.find(([c]) => c === code)?.[1] ?? code;
}
