import Foundation

/// Decides what the window shows and when the app starts Backstory's server,
/// from health answers and server exits, so the window is up only while a
/// Backstory answers. Pure, so every transition is tested without a server.
struct ServerState {
    /// Owned: the app starts the server from its bundle and restarts it.
    /// Attached: it shows whatever answers at `server` and never starts one.
    enum Mode {
        case owned
        case attached
    }

    enum Phase: Equatable {
        case starting
        case showing
        case restarting
        case failed(Failure)
        case attachedWaiting
    }

    enum Failure: Equatable {
        case portInUse
        case keepsStopping
    }

    /// What the window controller does after an event. A spawn replaces any
    /// server the app is already running.
    struct Effect: Equatable {
        var spawnAfter: TimeInterval?
        var stop = false
        var load: URL?

        static let none = Effect()
    }

    /// Restarts back off by death count inside `budgetWindow`; one more death
    /// than there are delays gives up, so a server that can't start doesn't
    /// spin forever.
    static let restartDelays: [TimeInterval] = [0, 1, 2]
    static let budgetWindow: TimeInterval = 60

    /// A poll times out after two seconds, which a server busy with a big
    /// diff can exceed; restarting it then would throw away the work in
    /// flight. A server that has really gone misses every poll, so a few in a
    /// row are proof enough, and its exit is reported at once anyway.
    static let missedPollsBeforeRestart = 3

    let server: URL
    let mode: Mode
    let log: String?
    private(set) var phase: Phase
    private(set) var pending: URL?
    private(set) var lastAddress: URL?
    private var deaths: [Date] = []
    private var missedPolls = 0

    init(server: URL, mode: Mode, log: String? = nil) {
        self.server = server
        self.mode = mode
        self.log = log
        phase = mode == .owned ? .starting : .attachedWaiting
    }

    /// Applies a health poll's answer. `serverRunning` says whether a server
    /// the app started is running or about to be; when nothing answers and
    /// none is, the app starts one.
    mutating func healthAnswered(_ health: Health, serverRunning: Bool, at now: Date = Date()) -> Effect {
        if case .failed = phase { return .none }
        // Treat an odd answer while the app's own server runs as no answer:
        // that server holds the port, so it isn't another app's.
        let health = health == .other && serverRunning ? .nothing : health
        switch (health, mode) {
        case (.backstory, _):
            missedPolls = 0
            guard phase != .showing else { return .none }
            phase = .showing
            defer { pending = nil }
            return Effect(load: pending ?? lastAddress ?? URL(string: "/", relativeTo: server)!.absoluteURL)
        case (_, .attached):
            phase = .attachedWaiting
            return .none
        case (.other, .owned):
            phase = .failed(.portInUse)
            return Effect(stop: true)
        case (.nothing, .owned):
            switch phase {
            case .showing:
                guard serverRunning else { return died(at: now) }
                missedPolls += 1
                guard missedPolls >= Self.missedPollsBeforeRestart else { return .none }
                return died(at: now)
            case .starting, .restarting:
                return serverRunning ? .none : Effect(spawnAfter: 0)
            default:
                return .none
            }
        }
    }

    /// The server the app started has exited.
    mutating func processExited(at now: Date = Date()) -> Effect {
        guard mode == .owned else { return .none }
        if case .failed = phase { return .none }
        return died(at: now)
    }

    /// Puts the window back to waiting without starting anything; the next
    /// health answer decides whether the server has really gone.
    mutating func navigationFailed() {
        guard phase == .showing else { return }
        phase = mode == .owned ? .starting : .attachedWaiting
    }

    mutating func retry() {
        guard case .failed = phase else { return }
        phase = .starting
        deaths = []
    }

    /// Asks for a repo's address. Returns it to load now while the page is up;
    /// otherwise keeps it for when a Backstory answers, so a link that launches
    /// the app isn't dropped.
    mutating func open(_ address: URL) -> URL? {
        guard phase == .showing else {
            pending = address
            return nil
        }
        return address
    }

    /// Records where the page is, so a restart brings back the repo that was
    /// open rather than the inbox.
    mutating func pageMoved(to url: URL) {
        guard phase == .showing, url.scheme == server.scheme, url.host == server.host,
            url.port == server.port
        else { return }
        lastAddress = url
    }

    private mutating func died(at now: Date) -> Effect {
        missedPolls = 0
        deaths = deaths.filter { now.timeIntervalSince($0) < Self.budgetWindow } + [now]
        guard deaths.count <= Self.restartDelays.count else {
            phase = .failed(.keepsStopping)
            return Effect(stop: true)
        }
        phase = .restarting
        return Effect(spawnAfter: Self.restartDelays[deaths.count - 1])
    }

    var message: WaitingMessage {
        switch phase {
        case .starting, .showing:
            return WaitingMessage(title: "Starting Backstory…")
        case .restarting:
            return WaitingMessage(title: "Restarting Backstory…")
        case .attachedWaiting:
            return WaitingMessage(title: "Nothing is answering at \(server.absoluteString)")
        case .failed(.portInUse):
            return WaitingMessage(
                title: "Port \(server.port.map(String.init) ?? "") is in use by another app",
                detail: "Quit that app, then try again.",
                retry: true
            )
        case .failed(.keepsStopping):
            return WaitingMessage(
                title: "Backstory's server keeps stopping",
                detail: log.map { "Its log is at \($0)." },
                retry: true
            )
        }
    }
}

struct WaitingMessage: Equatable {
    var title: String
    var detail: String?
    var retry = false
}

enum Health {
    case backstory
    case other
    case nothing
}

/// Asks the server's `/api/health` whether what answers on the port is Backstory.
enum HealthProbe {
    static func isBackstory(_ data: Data) -> Bool {
        let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        return body?["app"] as? String == "backstory"
    }

    static func check(_ server: URL) async -> Health {
        let request = URLRequest(
            url: URL(string: "/api/health", relativeTo: server)!,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 2
        )
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200 && isBackstory(data) ? .backstory : .other
        } catch {
            return .nothing
        }
    }
}
