import { expect, test } from "bun:test";
import { HEIGHT, WIDTH, overlayPosition } from "./overlay-layout";

const area = { x: 100, y: 25, width: 1440, height: 875 };

test("the overlay is centred, near the top or the bottom of the work area", () => {
  expect(overlayPosition(area, "top")).toEqual({ x: 100 + (1440 - WIDTH) / 2, y: 37 });
  expect(overlayPosition(area, "bottom")).toEqual({ x: 100 + (1440 - WIDTH) / 2, y: 25 + 875 - HEIGHT - 28 });
});

test("odd sizes round to whole pixels", () => {
  expect(Number.isInteger(overlayPosition({ x: 0, y: 0, width: 1001, height: 701 }, "bottom").x)).toBe(true);
});
