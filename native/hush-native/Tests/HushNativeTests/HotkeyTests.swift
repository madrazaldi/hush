import CoreGraphics
import Testing

@testable import HushNative

private func hk(_ s: String) throws -> Hotkey { try Hotkey.parse(s) }

@Test func parsesSpecs() throws {
    #expect(try hk("Cmd+Shift+K") == Hotkey(modifiers: [.cmd, .shift], key: Key(name: "K")))
    #expect(try hk("cmd+shift+k") == hk("CMD+SHIFT+K"))
    #expect(try hk("Fn") == Hotkey(modifiers: .fn, key: nil))
    #expect(try hk("Fn+Shift") == Hotkey(modifiers: [.fn, .shift], key: nil))
    #expect(try hk("OptRight+Shift") == Hotkey(modifiers: [.optRight, .shift], key: nil))
    #expect(try hk("Ctrl+Opt+Space") == Hotkey(modifiers: [.ctrl, .opt], key: Key(name: "Space")))
    #expect(try hk("Cmd+Ctrl+V") == Hotkey(modifiers: [.cmd, .ctrl], key: Key(name: "V")))
    #expect(try hk("AltGr+esc") == Hotkey(modifiers: .optRight, key: .escape))
    #expect(try hk("F13").key == Key(name: "F13"))
    #expect(try hk("Globe").key == Key(name: "Dictation"))
    #expect(try hk("CmdLeft+ShiftRight+K").modifiers == [.cmdLeft, .shiftRight])
}

@Test func rejectsBadSpecs() {
    #expect(throws: HushError.self) { try hk("") }
    #expect(throws: HushError.self) { try hk("Banana+Nope") }
    #expect(throws: HushError.self) { try hk("A+B") }
    #expect(throws: HushError.self) { try hk("Cmd+Unknown") }
}

@Test func keycodesMapBothWays() {
    #expect(Key.fromKeycode(0x00) == Key(name: "A"))
    #expect(Key.fromKeycode(0x31) == Key(name: "Space"))
    #expect(Key.fromKeycode(0x7A) == Key(name: "F1"))
    #expect(Key.fromKeycode(0x37) == nil)  // Command is a modifier, not a key
}

@Test func modifierMatching() {
    let cmd = Modifiers.cmd
    #expect(cmd.matches(.cmdLeft))
    #expect(cmd.matches(.cmdRight))
    #expect(!cmd.matches([]))
    #expect(!cmd.matches([.cmdLeft, .shiftLeft]))  // extra group held
    #expect(Modifiers.cmdLeft.matches([.cmdLeft, .cmdRight]))
    #expect(!Modifiers.cmdLeft.matches(.cmdRight))
    #expect(Modifiers([.cmd, .fn]).matches([.cmdLeft, .fn]))
    #expect(!Modifiers([.cmd, .fn]).matches(.cmdLeft))  // missing Fn
    #expect(!cmd.matches([.cmdLeft, .fn]))  // extra Fn
}

@Test func pressAndReleaseOfAKeyHotkey() throws {
    var s = HotkeyState()
    let id = try s.register(hk("Cmd+K"))
    let k = Key(name: "K")
    #expect(s.process(KeyEvent(modifiers: .cmdLeft, key: k, isKeyDown: true)).map { $0.1 } == [true])
    // Key repeat does not press again.
    #expect(s.process(KeyEvent(modifiers: .cmdLeft, key: k, isKeyDown: true)).isEmpty)
    let up = s.process(KeyEvent(modifiers: .cmdLeft, key: k, isKeyDown: false))
    #expect(up.count == 1 && up[0].0 == id && !up[0].1)
    // Wrong modifiers.
    #expect(s.process(KeyEvent(modifiers: .shiftLeft, key: k, isKeyDown: true)).isEmpty)
}

@Test func releasingTheModifierReleasesTheHotkey() throws {
    var s = HotkeyState()
    _ = try s.register(hk("Cmd+K"))
    _ = s.process(KeyEvent(modifiers: .cmdLeft, key: Key(name: "K"), isKeyDown: true))
    #expect(s.process(KeyEvent(modifiers: [], key: nil, isKeyDown: false)).map { $0.1 } == [false])
}

@Test func modifierOnlyHotkeys() throws {
    var s = HotkeyState()
    _ = try s.register(hk("Fn"))
    let fnShift = try s.register(hk("Fn+Shift"))
    #expect(s.process(KeyEvent(modifiers: .fn, key: nil, isKeyDown: true)).map { $0.1 } == [true])
    // Adding Shift completes Fn+Shift; Fn stays held (presses never release anything).
    let pressed = s.process(KeyEvent(modifiers: [.fn, .shiftLeft], key: nil, isKeyDown: true))
    #expect(pressed.count == 1 && pressed[0].0 == fnShift)
    // Releasing Shift releases Fn+Shift only, since Fn alone matches again; then Fn goes.
    #expect(s.process(KeyEvent(modifiers: .fn, key: nil, isKeyDown: false)).count == 1)
    #expect(s.process(KeyEvent(modifiers: [], key: nil, isKeyDown: false)).count == 1)
}

@Test func blockingAndDuplicates() throws {
    var s = HotkeyState()
    _ = try s.register(hk("Fn"))
    #expect(throws: HushError.self) { try s.register(hk("fn")) }
    #expect(s.shouldBlock(.fn, nil))
    #expect(!s.shouldBlock([.fn, .cmdLeft], nil))
    #expect(!s.shouldBlock(.fn, Key(name: "A")))
}

@Test func reconcileFixesDrift() {
    var m: Modifiers = [.ctrlLeft, .shiftRight, .fn]
    reconcile(&m, [])
    #expect(m == .fn)  // Fn is tracked through flags, not reconciled
    reconcile(&m, .maskCommand)
    #expect(m == [.fn, .cmdLeft])
}
