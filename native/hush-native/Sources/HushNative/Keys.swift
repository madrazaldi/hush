// Hotkey specs ("Cmd+Shift+K", "Fn", "OptRight+Space") and the matching rules, compatible with the
// handy-keys crate the Rust helper used, so settings written by earlier versions keep working.

import Foundation

public struct Modifiers: OptionSet, Hashable, Sendable {
    public let rawValue: UInt32
    public init(rawValue: UInt32) { self.rawValue = rawValue }

    public static let cmdLeft = Modifiers(rawValue: 1 << 0)
    public static let shiftLeft = Modifiers(rawValue: 1 << 1)
    public static let ctrlLeft = Modifiers(rawValue: 1 << 2)
    public static let optLeft = Modifiers(rawValue: 1 << 3)
    public static let fn = Modifiers(rawValue: 1 << 4)
    public static let cmdRight = Modifiers(rawValue: 1 << 5)
    public static let shiftRight = Modifiers(rawValue: 1 << 6)
    public static let ctrlRight = Modifiers(rawValue: 1 << 7)
    public static let optRight = Modifiers(rawValue: 1 << 8)

    public static let cmd: Modifiers = [.cmdLeft, .cmdRight]
    public static let shift: Modifiers = [.shiftLeft, .shiftRight]
    public static let ctrl: Modifiers = [.ctrlLeft, .ctrlRight]
    public static let opt: Modifiers = [.optLeft, .optRight]

    private static let groups: [(Modifiers, Modifiers)] = [
        (.cmdLeft, .cmdRight), (.shiftLeft, .shiftRight), (.ctrlLeft, .ctrlRight), (.optLeft, .optRight),
    ]

    private static let names: [String: Modifiers] = {
        var m: [String: Modifiers] = [:]
        func add(_ mods: Modifiers, _ names: String) {
            for n in names.split(separator: " ") { m[String(n)] = mods }
        }
        add(.cmd, "cmd command meta super win windows")
        add(.shift, "shift")
        add(.ctrl, "ctrl control")
        add(.opt, "opt option alt")
        add(.fn, "fn function")
        add(
            .cmdLeft,
            "cmdleft cmd_left lcmd commandleft command_left lcommand superleft super_left winleft win_left windowsleft windows_left metaleft meta_left"
        )
        add(.shiftLeft, "shiftleft shift_left lshift")
        add(.ctrlLeft, "ctrlleft ctrl_left lctrl controlleft control_left lcontrol")
        add(.optLeft, "optleft opt_left lopt optionleft option_left loption altleft alt_left lalt")
        add(
            .cmdRight,
            "cmdright cmd_right rcmd commandright command_right rcommand superright super_right winright win_right windowsright windows_right metaright meta_right"
        )
        add(.shiftRight, "shiftright shift_right rshift")
        add(.ctrlRight, "ctrlright ctrl_right rctrl controlright control_right rcontrol")
        add(.optRight, "optright opt_right ropt optionright option_right roption altright alt_right ralt altgr")
        return m
    }()

    static func parse(_ s: String) -> Modifiers? { names[s.lowercased()] }

    /// Whether the modifiers held in an event satisfy this hotkey's modifiers. A side-agnostic
    /// modifier accepts either side, a side-specific one needs that side, groups the hotkey does
    /// not mention must not be held, and Fn must match exactly.
    public func matches(_ event: Modifiers) -> Bool {
        for (left, right) in Self.groups {
            let wantLeft = contains(left)
            let wantRight = contains(right)
            let hasLeft = event.contains(left)
            let hasRight = event.contains(right)
            if wantLeft && wantRight {
                if !hasLeft && !hasRight { return false }
            } else if wantLeft {
                if !hasLeft { return false }
            } else if wantRight {
                if !hasRight { return false }
            } else if hasLeft || hasRight {
                return false
            }
        }
        return contains(.fn) == event.contains(.fn)
    }
}

/// A non-modifier key, by canonical name.
public struct Key: Hashable, Sendable, CustomStringConvertible {
    public let name: String
    public var description: String { name }

    /// (canonical name, extra aliases, macOS virtual keycode). Keys without a keycode parse but
    /// never fire on a Mac (or arrive as mouse buttons).
    private static let table: [(String, String, UInt16?)] = {
        var t: [(String, String, UInt16?)] = []
        let letters: [(String, UInt16)] = [
            ("A", 0x00), ("S", 0x01), ("D", 0x02), ("F", 0x03), ("H", 0x04), ("G", 0x05), ("Z", 0x06), ("X", 0x07),
            ("C", 0x08), ("V", 0x09), ("B", 0x0B), ("Q", 0x0C), ("W", 0x0D), ("E", 0x0E), ("R", 0x0F), ("Y", 0x10),
            ("T", 0x11), ("O", 0x1F), ("U", 0x20), ("I", 0x22), ("P", 0x23), ("L", 0x25), ("J", 0x26), ("K", 0x28),
            ("N", 0x2D), ("M", 0x2E),
        ]
        for (n, c) in letters { t.append((n, "", c)) }
        let digits: [UInt16] = [0x1D, 0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1A, 0x1C, 0x19]
        for (i, c) in digits.enumerated() { t.append(("\(i)", "num\(i)", c)) }
        t += [("PlayPause", "", nil), ("Stop", "", nil), ("PrevTrack", "", nil), ("NextTrack", "", nil)]
        let fkeys: [UInt16] = [
            0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F, 0x69, 0x6B, 0x71, 0x6A, 0x40,
            0x4F, 0x50, 0x5A,
        ]
        for (i, c) in fkeys.enumerated() { t.append(("F\(i + 1)", "", c)) }
        for i in 21...24 { t.append(("F\(i)", "", nil)) }
        t += [
            ("Space", "", 0x31), ("Return", "enter", 0x24), ("Tab", "", 0x30), ("Escape", "esc", 0x35),
            ("Delete", "backspace", 0x33), ("ForwardDelete", "del", 0x75), ("Insert", "ins", 0x72),
            ("Pause", "break", nil), ("Home", "", 0x73), ("End", "", 0x77), ("PageUp", "", 0x74),
            ("PageDown", "", 0x79), ("Left", "leftarrow", 0x7B), ("Right", "rightarrow", 0x7C),
            ("Up", "uparrow", 0x7E), ("Down", "downarrow", 0x7D), ("-", "minus", 0x1B),
            ("=", "equal equals", 0x18), ("[", "leftbracket", 0x21), ("]", "rightbracket", 0x1E),
            ("\\", "backslash", 0x2A), (";", "semicolon", 0x29), ("'", "quote", 0x27), (",", "comma", 0x2B),
            (".", "period", 0x2F), ("/", "slash", 0x2C), ("`", "grave backtick", 0x32), ("§", "section", 0x0A),
            ("¥", "jisyen yen", 0x5D), ("JisUnderscore", "", 0x5E), ("Eisu", "jiseisu 英数", 0x66),
            ("Kana", "jiskana かな", 0x68),
        ]
        let keypad: [UInt16] = [0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5B, 0x5C]
        for (i, c) in keypad.enumerated() { t.append(("Keypad\(i)", "", c)) }
        t += [
            ("KeypadDecimal", "keypad.", 0x41), ("KeypadMultiply", "keypad*", 0x43), ("KeypadPlus", "keypad+", 0x45),
            ("KeypadClear", "", 0x47), ("KeypadDivide", "keypad/", 0x4B), ("KeypadEnter", "", 0x4C),
            ("KeypadMinus", "keypad-", 0x4E), ("KeypadEquals", "keypad=", 0x51), ("KeypadComma", "keypad,", 0x5F),
            ("CapsLock", "caps", 0x39), ("ScrollLock", "scroll", nil), ("NumLock", "", nil),
            ("PrintScreen", "prtsc sysrq", nil), ("ContextMenu", "menu apps application", 0x6E),
            ("MouseLeft", "leftclick lmb mouse1", nil), ("MouseRight", "rightclick rmb mouse2", nil),
            ("MouseMiddle", "middleclick mmb mouse3", nil), ("MouseX1", "mouse4 back xbutton1", nil),
            ("MouseX2", "mouse5 forward xbutton2", nil), ("Dictation", "voice globe", 0xB0),
        ]
        return t
    }()

    private static let byName: [String: Key] = {
        var m: [String: Key] = [:]
        for (name, aliases, _) in table {
            m[name.lowercased()] = Key(name: name)
            for a in aliases.split(separator: " ") { m[a.lowercased()] = Key(name: name) }
        }
        return m
    }()

    private static let byCode: [UInt16: Key] = {
        var m: [UInt16: Key] = [:]
        for (name, _, code) in table { if let code { m[code] = Key(name: name) } }
        return m
    }()

    static let escape = Key(name: "Escape")
    static let capsLock = Key(name: "CapsLock")
    static let mouseLeft = Key(name: "MouseLeft")
    static let mouseRight = Key(name: "MouseRight")
    static let mouseMiddle = Key(name: "MouseMiddle")
    static let mouseX1 = Key(name: "MouseX1")
    static let mouseX2 = Key(name: "MouseX2")

    static func parse(_ s: String) throws -> Key {
        let t = s.trimmingCharacters(in: .whitespaces)
        if let k = byName[t.lowercased()] { return k }
        throw HushError("Unknown key: \(t)")
    }

    static func fromKeycode(_ code: UInt16) -> Key? { byCode[code] }
}

public struct Hotkey: Hashable, Sendable {
    public let modifiers: Modifiers
    public let key: Key?

    public init(modifiers: Modifiers, key: Key?) throws {
        if modifiers.isEmpty && key == nil {
            throw HushError("Hotkey cannot be empty (must have at least a key or modifiers)")
        }
        self.modifiers = modifiers
        self.key = key
    }

    public static func parse(_ spec: String) throws -> Hotkey {
        let s = spec.trimmingCharacters(in: .whitespaces)
        if s.isEmpty { throw HushError("Hotkey cannot be empty (must have at least a key or modifiers)") }
        var modifiers: Modifiers = []
        var key: Key?
        for raw in s.split(separator: "+", omittingEmptySubsequences: false) {
            let part = raw.trimmingCharacters(in: .whitespaces)
            if part.isEmpty { continue }
            if let m = Modifiers.parse(part) {
                modifiers.formUnion(m)
            } else {
                if key != nil {
                    throw HushError(
                        "Invalid hotkey format: Multiple keys specified: already have a key, found '\(part)'")
                }
                key = try Key.parse(part)
            }
        }
        return try Hotkey(modifiers: modifiers, key: key)
    }
}

/// One keyboard (or mouse button) transition, with the modifiers held at that moment.
struct KeyEvent {
    let modifiers: Modifiers
    let key: Key?
    let isKeyDown: Bool
}

/// Registered hotkeys and which of them are currently held.
struct HotkeyState {
    private(set) var hotkeys: [Int: Hotkey] = [:]
    private var nextID = 0
    private var pressed: Set<Int> = []

    mutating func register(_ hotkey: Hotkey) throws -> Int {
        if hotkeys.values.contains(hotkey) { throw HushError("Hotkey already registered") }
        let id = nextID
        nextID += 1
        hotkeys[id] = hotkey
        return id
    }

    mutating func unregister(_ id: Int) {
        hotkeys[id] = nil
        pressed.remove(id)
    }

    mutating func removeAll() {
        hotkeys.removeAll()
        pressed.removeAll()
    }

    /// Whether the event should be swallowed instead of reaching the focused app.
    func shouldBlock(_ modifiers: Modifiers, _ key: Key?) -> Bool {
        hotkeys.values.contains { $0.modifiers.matches(modifiers) && $0.key == key }
    }

    /// The hotkeys this event presses (true) or releases (false).
    mutating func process(_ event: KeyEvent) -> [(Int, Bool)] {
        var out: [(Int, Bool)] = []
        for (id, hk) in hotkeys.sorted(by: { $0.key < $1.key }) {
            if event.isKeyDown {
                if hk.modifiers.matches(event.modifiers) && hk.key == event.key && !pressed.contains(id) {
                    pressed.insert(id)
                    out.append((id, true))
                }
            } else if pressed.contains(id) {
                // Released when its key is released, or (for modifier events) when the modifiers no
                // longer match. A modifier event whose modifiers still match must not release a
                // modifier-only hotkey (e.g. tapping Shift while a Cmd-only hotkey is held).
                let released =
                    (event.key != nil && hk.key == event.key)
                    || (event.key == nil && !hk.modifiers.matches(event.modifiers))
                if released {
                    pressed.remove(id)
                    out.append((id, false))
                }
            }
        }
        return out
    }
}
