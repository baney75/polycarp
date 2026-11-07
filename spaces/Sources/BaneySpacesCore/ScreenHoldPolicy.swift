import Foundation

/// When a workspace switch may hold the screen (`ScreenHold`). Off until measured on the real screen with `scripts/switch-frames-probe.py`:
/// `defaults write com.baney.baneyspaces atomicSwitch -bool true`. The same installed build measures both ways.
public enum ScreenHoldPolicy {
    public static let defaultsKey = "atomicSwitch"
    /// Long enough for the p99 of a real switch to reach focus (88 ms measured), short enough that nobody reads it as a freeze.
    public static let longest: TimeInterval = 0.12

    public static var isOn: Bool { UserDefaults.standard.bool(forKey: defaultsKey) }
}
