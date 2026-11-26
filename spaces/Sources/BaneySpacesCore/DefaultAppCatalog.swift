import Foundation

/// The apps and programs Polycarp knows for each job, best first. Data only: what isn't installed is never shown, and
/// any installed app can be picked whether it is here or not.
public enum DefaultAppCatalog {
    public struct Entry: Equatable, Sendable {
        public let app: DefaultApp
        public let name: String
    }

    /// A program that runs in a terminal.
    public struct Command: Equatable, Sendable {
        public let id: String
        public let name: String
        /// The names it may be installed under, best first.
        public let programs: [String]
    }

    public static func entries(_ role: AppRole) -> [Entry] {
        commands(role).map { Entry(app: .command($0.id), name: $0.name) } + apps(role).map { Entry(app: .app($0.0), name: $0.1) }
    }

    public static func command(_ id: String, for role: AppRole) -> Command? { commands(role).first { $0.id == id } }

    /// A name to say for an app that may not be installed.
    public static func name(_ app: DefaultApp, for role: AppRole) -> String {
        entries(role).first { $0.app == app }?.name ?? app.id
    }

    /// Terminals that take a command line to run. Warp and Hyper open a window at a folder and nothing more, and
    /// Polycarp knows no way to hand a command to a terminal it has no entry for.
    public static let runsCommands: Set<String> = [
        "com.mitchellh.ghostty", "com.googlecode.iterm2", "com.github.wez.wezterm", "net.kovidgoyal.kitty",
        "org.alacritty", "com.raphaelamorim.rio", TerminalChoice.terminal,
    ]

    static func note(_ bundle: String, for role: AppRole) -> String? {
        role == .terminal && !runsCommands.contains(bundle) ? "Can't be told what to run, so programs open in another terminal" : nil
    }

    public static func commands(_ role: AppRole) -> [Command] {
        switch role {
        case .agent: agents
        case .editor: editors
        default: []
        }
    }

    private static let editors = [
        Command(id: "nvim", name: "Neovim", programs: ["nvim"]),
        Command(id: "hx", name: "Helix", programs: ["hx"]),
    ]

    private static let agents = [
        Command(id: "claude", name: "Claude Code", programs: ["claude"]),
        Command(id: "codex", name: "Codex", programs: ["codex"]),
        Command(id: "grok", name: "Grok", programs: ["grok"]),
        Command(id: "opencode", name: "OpenCode", programs: ["opencode"]),
        Command(id: "pi", name: "Pi", programs: ["pi"]),
        Command(id: "gemini", name: "Gemini", programs: ["agy", "gemini"]),
        Command(id: "copilot", name: "GitHub Copilot", programs: ["copilot"]),
        Command(id: "cursor-agent", name: "Cursor Agent", programs: ["cursor-agent"]),
        Command(id: "crush", name: "Crush", programs: ["crush"]),
        Command(id: "kimi", name: "Kimi", programs: ["kimi"]),
        Command(id: "qwen", name: "Qwen Code", programs: ["qwen"]),
        Command(id: "amp", name: "Amp", programs: ["amp"]),
        Command(id: "devin", name: "Devin", programs: ["devin"]),
        Command(id: "hermes", name: "Hermes", programs: ["hermes"]),
    ]

    /// Flick has no installer yet: like every app here, it is offered only once Launch Services finds it.
    public static let flick = "com.dbaney.flick"
    public static let quickTime = "com.apple.QuickTimePlayerX"

    private static func apps(_ role: AppRole) -> [(String, String)] {
        switch role {
        case .agent:
            [("com.t3tools.t3code", "T3 Code"), ("com.anthropic.claudefordesktop", "Claude"), ("com.openai.codex", "ChatGPT"),
             ("com.openai.chat", "ChatGPT"), ("com.todesktop.230313mzl4w4u92", "Cursor"), ("com.electron.ollama", "Ollama"),
             ("ai.elementlabs.lmstudio", "LM Studio"), ("org.local.studio.t3", "Local Studio")]
        case .browser:
            [("com.baney.polycarp.browser", "Polycarp Browser"), ("com.apple.Safari", "Safari"), ("net.imput.helium", "Helium"),
             ("com.google.Chrome", "Google Chrome"), ("org.mozilla.firefox", "Firefox"), ("company.thebrowser.Browser", "Arc"),
             ("company.thebrowser.dia", "Dia"), ("app.zen-browser.zen", "Zen"), ("com.brave.Browser", "Brave"),
             ("com.microsoft.edgemac", "Microsoft Edge"), ("com.vivaldi.Vivaldi", "Vivaldi"), ("com.operasoftware.Opera", "Opera"),
             ("com.kagi.kagimacOS", "Orion"), ("com.duckduckgo.macos.browser", "DuckDuckGo"), ("org.chromium.Chromium", "Chromium")]
        case .terminal:
            [("com.mitchellh.ghostty", "Ghostty"), ("com.googlecode.iterm2", "iTerm2"), ("com.github.wez.wezterm", "WezTerm"),
             ("net.kovidgoyal.kitty", "kitty"), ("org.alacritty", "Alacritty"), ("com.raphaelamorim.rio", "Rio"),
             ("dev.warp.Warp-Stable", "Warp"), ("co.zeit.hyper", "Hyper"), (TerminalChoice.terminal, "Terminal")]
        case .editor:
            [("dev.zed.Zed", "Zed"), ("com.microsoft.VSCode", "Visual Studio Code"), ("com.todesktop.230313mzl4w4u92", "Cursor"),
             ("com.sublimetext.4", "Sublime Text"), ("com.panic.Nova", "Nova"), ("com.barebones.bbedit", "BBEdit"),
             ("com.macromates.TextMate", "TextMate"), ("com.coteditor.CotEditor", "CotEditor"), ("org.vim.MacVim", "MacVim"),
             ("org.gnu.Emacs", "Emacs"), ("com.apple.dt.Xcode", "Xcode"), ("com.apple.TextEdit", "TextEdit")]
        case .files:
            [("com.apple.finder", "Finder"), ("com.cocoatech.PathFinder", "Path Finder"), ("com.binarynights.ForkLift", "ForkLift"),
             ("org.yanex.marta", "Marta")]
        case .mail:
            [("com.apple.mail", "Mail"), ("com.microsoft.Outlook", "Microsoft Outlook"), ("com.readdle.SparkDesktop", "Spark"),
             ("com.mimestream.Mimestream", "Mimestream"), ("org.mozilla.thunderbird", "Thunderbird"),
             ("ch.protonmail.desktop", "Proton Mail"), ("it.bloop.airmail2", "Airmail")]
        case .messages:
            [("com.apple.MobileSMS", "Messages"), ("org.whispersystems.signal-desktop", "Signal"), ("net.whatsapp.WhatsApp", "WhatsApp"),
             ("ru.keepcoder.Telegram", "Telegram"), ("com.tinyspeck.slackmacgap", "Slack"), ("com.hnc.Discord", "Discord"),
             ("com.automattic.beeper.desktop", "Beeper"), ("com.microsoft.teams2", "Microsoft Teams")]
        case .calendar:
            [("com.apple.iCal", "Calendar"), ("com.flexibits.fantastical2.mac", "Fantastical"), ("com.busymac.busycal3", "BusyCal"),
             ("com.cron.electron", "Notion Calendar"), ("com.microsoft.Outlook", "Microsoft Outlook")]
        case .notes:
            [("com.apple.Notes", "Notes"), ("md.obsidian", "Obsidian"), ("notion.id", "Notion"), ("net.shinyfrog.bear", "Bear"),
             ("com.lukilabs.lukiapp", "Craft"), ("com.electron.logseq", "Logseq"), ("com.evernote.Evernote", "Evernote"),
             ("net.cozic.joplin-desktop", "Joplin")]
        case .music:
            [("com.apple.Music", "Music"), ("com.spotify.client", "Spotify"), ("com.tidal.desktop", "TIDAL"), ("tv.plex.plexamp", "Plexamp"),
             (flick, "Flick")]
        case .video:
            // QuickTime Player comes with macOS, so a Mac always has an answer.
            [(flick, "Flick"), ("com.colliderli.iina", "IINA"), ("org.videolan.vlc", "VLC"), (quickTime, "QuickTime Player")]
        case .passwords:
            [("com.apple.Passwords", "Passwords"), ("com.1password.1password", "1Password"), ("com.bitwarden.desktop", "Bitwarden"),
             ("me.proton.pass.electron", "Proton Pass"), ("org.keepassxc.keepassxc", "KeePassXC"),
             ("com.markmcguill.strongbox.mac", "Strongbox")]
        }
    }
}
