import { convertFileSrc } from "@tauri-apps/api/core";

// Keep in sync with src-tauri/src/audio/decode.rs.
export const MEDIA_EXTS = [
  "wav", "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "aiff", "aif", "caf", "wma", "amr", "webm", "mp4",
  "m4v", "mov", "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "3gp",
];
export const VIDEO_EXTS = ["mp4", "m4v", "mov", "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "3gp", "webm"];

export function isVideo(path: string | null | undefined): boolean {
  return !!path && VIDEO_EXTS.includes(path.split(".").pop()?.toLowerCase() ?? "");
}

export function assetUrl(path: string | null | undefined): string | null {
  return path ? convertFileSrc(path) : null;
}

export function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}
