// Text insertion into the focused app: paste through the clipboard (restoring it afterwards),
// typed keystrokes, Return, and reading the current selection.
//
// Keystrokes are synthesized with Core Graphics events using fixed virtual key codes. That
// deliberately avoids anything that resolves keys through Text Input Sources (which macOS asserts
// must run on the main queue), so every function here is safe to call from any thread.
//
// Electrobun's clipboard API only reads and writes plain text, so the pasteboard work (snapshot of
// every type, change count, "transient" markers for clipboard managers) stays here too.

import CoreGraphics
import Foundation

public enum Input {
    /// Bumped by `input.cancel`. Every insertion remembers the value it started with and stops as
    /// soon as it changes.
    private static var cancelGeneration = 0
    private static let lock = NSLock()

    public static func cancel() {
        lock.withLock { cancelGeneration += 1 }
    }

    /// A cheap "has this insertion been cancelled?" probe.
    static func watcher() -> () -> Bool {
        let start = lock.withLock { cancelGeneration }
        return { lock.withLock { cancelGeneration } != start }
    }

    private static let keyCommand: CGKeyCode = 55
    private static let keyC: CGKeyCode = 8
    private static let keyV: CGKeyCode = 9
    private static let keyReturn: CGKeyCode = 36
    private static let keyTab: CGKeyCode = 48

    private static func sleep(ms: Int) { Thread.sleep(forTimeInterval: Double(ms) / 1000) }

    /// Post one key event. `unicode` overrides the character the key produces (used for typing
    /// text that has no physical key).
    private static func postKey(_ key: CGKeyCode, down: Bool, flags: CGEventFlags = [], unicode: [UniChar]? = nil)
        throws
    {
        guard let ev = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: down) else {
            throw HushError("input simulation unavailable")
        }
        ev.flags = flags
        if let u = unicode { ev.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u) }
        ev.post(tap: .cghidEventTap)
    }

    private static func click(_ key: CGKeyCode, flags: CGEventFlags = []) throws {
        try postKey(key, down: true, flags: flags)
        try postKey(key, down: false, flags: flags)
    }

    /// Press ⌘ + `key`, holding it briefly so slow apps don't drop it.
    private static func commandChord(_ key: CGKeyCode) throws {
        try postKey(keyCommand, down: true, flags: .maskCommand)
        sleep(ms: 15)
        try click(key, flags: .maskCommand)
        sleep(ms: 60)
        try postKey(keyCommand, down: false)
    }

    public static func pressEnter(command: Bool) throws {
        if command { try commandChord(keyReturn) } else { try click(keyReturn) }
    }

    /// Type text as keystrokes. Cancellation is checked between chunks so Escape can stop a long
    /// insertion part-way. Returns whether everything was typed.
    public static func type(_ text: String) throws -> Bool {
        let cancelled = watcher()
        // Typing very long strings in one go can drop characters in some apps.
        let chars = Array(text)
        for start in stride(from: 0, to: chars.count, by: 64) {
            if cancelled() { return false }
            var run: [UniChar] = []
            func flush() throws {
                // CGEventKeyboardSetUnicodeString carries at most 20 UTF-16 units per event.
                for i in stride(from: 0, to: run.count, by: 20) {
                    let part = Array(run[i..<min(i + 20, run.count)])
                    try postKey(0, down: true, unicode: part)
                    try postKey(0, down: false, unicode: part)
                }
                run.removeAll()
            }
            for c in chars[start..<min(start + 64, chars.count)] {
                switch c {
                case "\n", "\r", "\r\n":
                    try flush()
                    try click(keyReturn)
                case "\t":
                    try flush()
                    try click(keyTab)
                default:
                    run.append(contentsOf: String(c).utf16)
                }
            }
            try flush()
            sleep(ms: 8)
        }
        return true
    }

    /// Insert text by pasting through the clipboard, restoring the previous clipboard afterwards
    /// unless the user changed it in the meantime. Cancellation is checked right before ⌘V, after
    /// the pasteboard settles. Returns whether ⌘V was pressed.
    public static func paste(_ text: String, restore: Bool) throws -> Bool {
        let cancelled = watcher()
        let snapshot = restore ? Pasteboard.snapshot() : nil
        let change = Pasteboard.setText(text, transient: true)
        sleep(ms: 40)
        if cancelled() {
            if let snapshot, Pasteboard.changeCount == change { Pasteboard.restore(snapshot) }
            return false
        }
        try commandChord(keyV)
        if let snapshot {
            // Give the target app time to read the pasteboard before restoring.
            sleep(ms: 350)
            if Pasteboard.changeCount == change { Pasteboard.restore(snapshot) }
        }
        return true
    }

    /// Copy the current selection in the focused app (via ⌘C), restoring the clipboard.
    public static func selectedText() throws -> String? {
        let snap = Pasteboard.snapshot()
        let before = Pasteboard.changeCount
        try commandChord(keyC)
        var text: String?
        for _ in 0..<12 {
            sleep(ms: 25)
            if Pasteboard.changeCount != before {
                text = Pasteboard.text()
                break
            }
        }
        if let snap { Pasteboard.restore(snap) }
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return text
    }
}
