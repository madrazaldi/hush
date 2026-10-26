import { expect, test } from "bun:test";
import { asString, meetingAppsFor, parseLsappinfo } from "./platform";

test("AppleScript string literals are escaped", () => {
  expect(asString('say "hi" \\ there')).toBe('"say \\"hi\\" \\\\ there"');
  expect(asString("plain")).toBe('"plain"');
});

test("lsappinfo output is parsed", () => {
  expect(parseLsappinfo('"Safari"\nbundleID="com.apple.Safari"\n')).toEqual({ name: "Safari", bundle_id: "com.apple.Safari" });
  expect(parseLsappinfo("")).toEqual({ name: "", bundle_id: "" });
});

test("meeting apps are recognised by bundle id prefix and de-duplicated", () => {
  expect(meetingAppsFor(["us.zoom.xos", "com.microsoft.teams2", "com.microsoft.teams", "com.example.other"])).toEqual(["Zoom", "Microsoft Teams"]);
  expect(meetingAppsFor([])).toEqual([]);
});
