import Foundation

/// Whether the window shows differ's page or the native waiting view, and the
/// repo to open once the server answers.
struct ServerState {
    enum Phase: Equatable {
        case waiting
        case showing
    }

    let server: URL
    private(set) var phase = Phase.waiting
    private(set) var pending: URL?

    init(server: URL) {
        self.server = server
    }

    /// Applies a health poll's answer. Returns the address to load when the
    /// answer brings the page up.
    mutating func healthAnswered(isDiffer: Bool) -> URL? {
        guard isDiffer else {
            phase = .waiting
            return nil
        }
        guard phase == .waiting else { return nil }
        phase = .showing
        defer { pending = nil }
        return pending ?? URL(string: "/", relativeTo: server)!.absoluteURL
    }

    mutating func navigationFailed() {
        phase = .waiting
    }

    /// Asks for a repo's address. Returns it to load now while the page is up;
    /// while waiting it is kept for when the server answers, so a link that
    /// launches the app isn't dropped.
    mutating func open(_ address: URL) -> URL? {
        guard phase == .showing else {
            pending = address
            return nil
        }
        return address
    }
}

/// Asks the server's `/api/health` whether what answers on the port is differ.
enum HealthProbe {
    static func isDiffer(_ data: Data) -> Bool {
        let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        return body?["app"] as? String == "differ"
    }

    static func check(_ server: URL) async -> Bool {
        let request = URLRequest(
            url: URL(string: "/api/health", relativeTo: server)!,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 2
        )
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200 && isDiffer(data)
        } catch {
            return false
        }
    }
}
