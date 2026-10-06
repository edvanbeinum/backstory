import Foundation
import Testing

@testable import differ

private let server = URL(string: "http://127.0.0.1:4460")!

/// Reads `repo` back out of an address the way the page does: URLSearchParams
/// turns `+` into a space before decoding.
private func repoParam(_ address: URL) -> String? {
    let query = URLComponents(url: address, resolvingAgainstBaseURL: false)?.percentEncodedQuery ?? ""
    for pair in query.split(separator: "&") {
        let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.first == "repo", parts.count == 2 else { continue }
        return parts[1].replacingOccurrences(of: "+", with: " ").removingPercentEncoding
    }
    return nil
}

@MainActor
struct RepoLinkTests {
    @Test func differOpenLinkLoadsTheRepoOnTheServer() {
        let link = URL(string: "differ://open?repo=/Users/me/code/app")!
        #expect(
            RepoLink.address(for: link, server: server)?.absoluteString
                == "http://127.0.0.1:4460/?repo=/Users/me/code/app")
    }

    @Test func awkwardPathsRoundTrip() {
        let repo = "/Users/me/my repo/c++ & co #2 =x%"
        let address = RepoLink.address(forRepo: repo, server: server)
        #expect(address.path == "/")
        #expect(repoParam(address) == repo)
    }

    @Test func linkFromTheCliRoundTrips() {
        let repo = "/Users/me/my repo/c++ & co"
        let encoded = repo.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        let link = URL(string: "differ://open?repo=\(encoded)")!
        #expect(repoParam(RepoLink.address(for: link, server: server)!) == repo)
    }

    @Test func folderFileUrlMapsToTheSameAddress() {
        let folder = URL(fileURLWithPath: "/Users/me/code/app", isDirectory: true)
        #expect(
            RepoLink.address(for: folder, server: server)
                == RepoLink.address(for: URL(string: "differ://open?repo=/Users/me/code/app")!, server: server))
    }

    @Test(arguments: [
        "https://open?repo=/Users/me/code/app",
        "differ://close?repo=/Users/me/code/app",
        "differ://open",
        "differ://open?path=/Users/me/code/app",
        "differ://open?repo=code/app",
    ])
    func ignoresAnythingElse(_ link: String) {
        #expect(RepoLink.address(for: URL(string: link)!, server: server) == nil)
    }

    @Test func overriddenServerKeepsItsPort() {
        let dev = URL(string: "http://127.0.0.1:3000")!
        #expect(
            RepoLink.address(forRepo: "/r", server: dev).absoluteString == "http://127.0.0.1:3000/?repo=/r")
    }
}

@MainActor
struct ServerStateTests {
    private var repo: URL { RepoLink.address(forRepo: "/Users/me/code/app", server: server) }

    @Test func waitsUntilDifferAnswers() {
        var state = ServerState(server: server)
        #expect(state.phase == .waiting)
        #expect(state.healthAnswered(isDiffer: true)?.absoluteString == "http://127.0.0.1:4460/")
        #expect(state.phase == .showing)
    }

    @Test func staysWaitingWhenSomethingElseAnswersOrNothingDoes() {
        var state = ServerState(server: server)
        #expect(state.healthAnswered(isDiffer: false) == nil)
        #expect(state.phase == .waiting)
    }

    @Test func aFailedPollPutsTheWaitingViewBack() {
        var state = ServerState(server: server)
        _ = state.healthAnswered(isDiffer: true)
        #expect(state.healthAnswered(isDiffer: false) == nil)
        #expect(state.phase == .waiting)
    }

    @Test func aFailedNavigationPutsTheWaitingViewBack() {
        var state = ServerState(server: server)
        _ = state.healthAnswered(isDiffer: true)
        state.navigationFailed()
        #expect(state.phase == .waiting)
    }

    @Test func anotherPollWhileShowingLoadsNothing() {
        var state = ServerState(server: server)
        _ = state.healthAnswered(isDiffer: true)
        #expect(state.healthAnswered(isDiffer: true) == nil)
        #expect(state.phase == .showing)
    }

    @Test func aLinkWhileWaitingIsLoadedWhenTheServerAnswers() {
        var state = ServerState(server: server)
        #expect(state.open(repo) == nil)
        #expect(state.healthAnswered(isDiffer: true) == repo)
        #expect(state.pending == nil)
    }

    @Test func aLinkWhileShowingLoadsAtOnce() {
        var state = ServerState(server: server)
        _ = state.healthAnswered(isDiffer: true)
        #expect(state.open(repo) == repo)
    }

    @Test func healthMustSayDiffer() {
        #expect(HealthProbe.isDiffer(Data(#"{"app":"differ","build":"x"}"#.utf8)))
        #expect(!HealthProbe.isDiffer(Data(#"{"app":"vite"}"#.utf8)))
        #expect(!HealthProbe.isDiffer(Data("<html>".utf8)))
    }
}
