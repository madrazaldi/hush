// Geometry of the dictation overlay (kept free of Electrobun imports so it can be unit tested).

import type { OverlayPosition } from "../lib/types";

export const WIDTH = 260;
export const HEIGHT = 72;

/** Where the overlay goes for a work area: centred horizontally, near the top or the bottom. */
export function overlayPosition(area: { x: number; y: number; width: number; height: number }, pos: OverlayPosition): { x: number; y: number } {
  const x = area.x + (area.width - WIDTH) / 2;
  const y = pos === "top" ? area.y + 12 : area.y + area.height - HEIGHT - 28;
  return { x: Math.round(x), y: Math.round(y) };
}
