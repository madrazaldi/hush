// Global hotkeys through a CGEventTap on a dedicated run-loop thread. If Accessibility isn't
// granted yet (or is revoked), the thread keeps retrying so hotkeys start working as soon as the
// user grants it. Matched events are swallowed so the focused app never sees them.

import ApplicationServices
import CoreGraphics
import Foundation

public enum Action: String, Codable, Sendable {
    case dictate
    case command
    case pasteLast = "paste_last"
    case cancel
}

public func validateHotkey(_ spec: String) throws {
    _ = try Hotkey.parse(spec)
}

private let fnKeycode: UInt16 = 0x3F

private let modifierKeycodes: [UInt16: Modifiers] = [
    0x37: .cmdLeft, 0x36: .cmdRight, 0x38: .shiftLeft, 0x3C: .shiftRight,
    0x3B: .ctrlLeft, 0x3E: .ctrlRight, 0x3A: .optLeft, 0x3D: .optRight, fnKeycode: .fn,
]

/// Correct tracked modifiers against the OS flags, for drift from missed events (tap disabled by
/// timeout, Mission Control, screen lock). Only valid outside FlagsChanged, whose flags already
/// include the change being reported.
func reconcile(_ current: inout Modifiers, _ flags: CGEventFlags) {
    let groups: [(CGEventFlags, Modifiers, Modifiers)] = [
        (.maskControl, .ctrl, .ctrlLeft), (.maskShift, .shift, .shiftLeft),
        (.maskCommand, .cmd, .cmdLeft), (.maskAlternate, .opt, .optLeft),
    ]
    for (flag, both, fallback) in groups {
        if !flags.contains(flag) {
            current.subtract(both)
        } else if current.isDisjoint(with: both) {
            // Held but we missed the press; assume the left key.
            current.insert(fallback)
        }
    }
}

public final class Hotkeys: @unchecked Sendable {
    public typealias Handler = (Action, Bool) -> Void

    private let handler: Handler
    private let lock = NSLock()
    private var state = HotkeyState()
    private var actions: [Int: Action] = [:]
    private var wanted: [(Action, String)] = []
    private var cancelID: Int?
    private var active = false
    /// Tap-thread state.
    private var tracked: Modifiers = []
    private var tap: CFMachPort?
    /// Handler calls leave the tap callback right away, in order.
    private let events = DispatchQueue(label: "hush-hotkey-events")

    public init(handler: @escaping Handler) {
        self.handler = handler
        let thread = Thread { [unowned self] in run() }
        thread.name = "hush-hotkeys"
        thread.start()
    }

    /// Replace the bindings. Returns human-readable errors for bindings that failed.
    public func bind(_ bindings: [(Action, String)]) -> [String] {
        lock.withLock {
            wanted = bindings
            cancelID = nil
            return active ? apply() : []
        }
    }

    /// Enable/disable the Esc cancel hotkey (only active while recording so Esc isn't swallowed
    /// globally).
    public func setCancelEnabled(_ on: Bool) {
        lock.withLock {
            guard active else { return }
            if on, cancelID == nil, let hk = try? Hotkey(modifiers: [], key: .escape), let id = try? state.register(hk)
            {
                cancelID = id
                actions[id] = .cancel
            } else if !on, let id = cancelID {
                state.unregister(id)
                actions[id] = nil
                cancelID = nil
            }
        }
    }

    /// Register `wanted` from scratch. Caller holds the lock.
    private func apply() -> [String] {
        state.removeAll()
        actions.removeAll()
        var errors: [String] = []
        for (action, spec) in wanted where !spec.trimmingCharacters(in: .whitespaces).isEmpty {
            do {
                let hk = try Hotkey.parse(spec)
                do {
                    actions[try state.register(hk)] = action
                } catch {
                    errors.append("\(spec): Hotkey already registered: \(spec)")
                }
            } catch {
                errors.append("\(spec): \(message(of: error))")
            }
        }
        return errors
    }

    private func run() {
        while true {
            if AXIsProcessTrusted(), let (port, source) = createTap() {
                let loop = CFRunLoopGetCurrent()
                CFRunLoopAddSource(loop, source, .commonModes)
                CGEvent.tapEnable(tap: port, enable: true)
                Log.info("global hotkeys active")
                lock.withLock {
                    active = true
                    for e in apply() { Log.warn("hotkey: \(e)") }
                }
                // Parks until the tap's port dies (e.g. the Accessibility grant was revoked). Tap
                // recovery after a timeout is event-driven, in the callback.
                while CFMachPortIsValid(port) {
                    CFRunLoopRunInMode(.defaultMode, 3600, false)
                }
                CFRunLoopRemoveSource(loop, source, .commonModes)
                lock.withLock {
                    active = false
                    state.removeAll()
                    actions.removeAll()
                    cancelID = nil
                }
                tap = nil
                Log.warn("global hotkeys stopped; retrying")
            } else {
                Log.debug("hotkeys unavailable (accessibility?)")
            }
            Thread.sleep(forTimeInterval: 2)
        }
    }

    private func createTap() -> (CFMachPort, CFRunLoopSource)? {
        let types: [CGEventType] = [
            .keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
            .otherMouseDown, .otherMouseUp,
        ]
        let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        let callback: CGEventTapCallBack = { _, type, event, refcon in
            let me = Unmanaged<Hotkeys>.fromOpaque(refcon!).takeUnretainedValue()
            return me.handle(type, event) ? nil : Unmanaged.passUnretained(event)
        }
        guard
            let port = CGEvent.tapCreate(
                tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask,
                callback: callback, userInfo: Unmanaged.passUnretained(self).toOpaque()),
            let source = CFMachPortCreateRunLoopSource(nil, port, 0)
        else { return nil }
        tap = port
        return (port, source)
    }

    /// Track one event; returns whether to swallow it.
    private func handle(_ type: CGEventType, _ event: CGEvent) -> Bool {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            // We may have missed events while disabled.
            reconcile(&tracked, CGEventSource.flagsState(.combinedSessionState))
            return false
        }
        let flags = event.flags
        if type != .flagsChanged { reconcile(&tracked, flags) }
        let fnHeld = flags.contains(.maskSecondaryFn)
        func withFn(_ m: Modifiers) -> Modifiers { fnHeld ? m.union(.fn) : m.subtracting(.fn) }
        let modifiers = withFn(tracked)
        let keycode = UInt16(truncatingIfNeeded: event.getIntegerValueField(.keyboardEventKeycode))

        switch type {
        case .keyDown, .keyUp:
            // Keycodes we can't map (Mission Control, the Globe key's configured action) carry no
            // usable information.
            guard let key = Key.fromKeycode(keycode) else { return false }
            return dispatch(KeyEvent(modifiers: modifiers, key: key, isKeyDown: type == .keyDown), block: true)
        case .flagsChanged:
            if let key = Key.fromKeycode(keycode) {
                // Caps Lock arrives as FlagsChanged but is not a modifier we track.
                return dispatch(
                    KeyEvent(modifiers: modifiers, key: key, isKeyDown: flags.contains(.maskAlphaShift)), block: true)
            }
            guard let bit = modifierKeycodes[keycode] else { return false }
            let down = !tracked.contains(bit)
            if down { tracked.insert(bit) } else { tracked.remove(bit) }
            let now = withFn(tracked)
            // Only a press can complete a modifier-only hotkey; releases always pass through.
            return dispatch(KeyEvent(modifiers: now, key: nil, isKeyDown: down), block: down)
        case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp:
            // Plain clicks are noise; only clicks with modifiers held can be hotkeys.
            guard !modifiers.isEmpty else { return false }
            let key: Key = type == .leftMouseDown || type == .leftMouseUp ? .mouseLeft : .mouseRight
            let down = type == .leftMouseDown || type == .rightMouseDown
            _ = dispatch(KeyEvent(modifiers: modifiers, key: key, isKeyDown: down), block: false)
            return false
        case .otherMouseDown, .otherMouseUp:
            let buttons: [Int64: Key] = [2: .mouseMiddle, 3: .mouseX1, 4: .mouseX2]
            guard let key = buttons[event.getIntegerValueField(.mouseEventButtonNumber)] else { return false }
            _ = dispatch(KeyEvent(modifiers: modifiers, key: key, isKeyDown: type == .otherMouseDown), block: false)
            return false
        default:
            return false
        }
    }

    private func dispatch(_ event: KeyEvent, block: Bool) -> Bool {
        let (swallow, fired) = lock.withLock {
            let swallow = block && state.shouldBlock(event.modifiers, event.key)
            let fired = state.process(event).compactMap { id, pressed in actions[id].map { ($0, pressed) } }
            return (swallow, fired)
        }
        if !fired.isEmpty {
            events.async { [handler] in
                for (action, pressed) in fired { handler(action, pressed) }
            }
        }
        return swallow
    }
}
