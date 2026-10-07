import AppKit
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

private let home = URL(string: "http://127.0.0.1:4460/")!

/// An owned-mode state showing the server the app started.
private func showingOwned() -> ServerState {
    var state = ServerState(server: server, mode: .owned, log: "/tmp/differ/server.log")
    _ = state.healthAnswered(.nothing, serverRunning: false)
    _ = state.healthAnswered(.differ, serverRunning: true)
    return state
}

@MainActor
struct ServerStateTests {
    private var repo: URL { RepoLink.address(forRepo: "/Users/me/code/app", server: server) }

    @Test func aServerExitWhileShowingRestartsItAndBringsBackTheLastPage() {
        var state = showingOwned()
        state.pageMoved(to: repo)
        #expect(state.processExited() == ServerState.Effect(spawnAfter: 0))
        #expect(state.phase == .restarting)
        #expect(state.healthAnswered(.differ, serverRunning: true) == ServerState.Effect(load: repo))
        #expect(state.phase == .showing)
    }

    @Test func aFailedPollWhileShowingRestartsTheServer() {
        var state = showingOwned()
        #expect(state.healthAnswered(.nothing, serverRunning: true) == ServerState.Effect(spawnAfter: 0))
        #expect(state.phase == .restarting)
    }

    @Test func ownedModeStartsTheServerWhenNothingAnswers() {
        var state = ServerState(server: server, mode: .owned)
        #expect(state.phase == .starting)
        #expect(state.healthAnswered(.nothing, serverRunning: false) == ServerState.Effect(spawnAfter: 0))
        #expect(state.healthAnswered(.nothing, serverRunning: true) == .none)
        #expect(state.phase == .starting)
        #expect(state.healthAnswered(.differ, serverRunning: true) == ServerState.Effect(load: home))
        #expect(state.phase == .showing)
    }

    @Test func threeDeathsInsideAMinuteRestartAndTheFourthGivesUp() {
        var state = showingOwned()
        let start = Date()
        let delays = (0..<3).compactMap {
            state.processExited(at: start.addingTimeInterval(Double($0) * 10)).spawnAfter
        }
        #expect(delays == ServerState.restartDelays)
        #expect(state.processExited(at: start.addingTimeInterval(30)) == ServerState.Effect(stop: true))
        #expect(state.phase == .failed(.keepsStopping))
        #expect(state.healthAnswered(.nothing, serverRunning: false) == .none)
    }

    @Test func deathsOlderThanAMinuteDontCount() {
        var state = showingOwned()
        let start = Date()
        for i in 0..<3 { _ = state.processExited(at: start.addingTimeInterval(Double(i))) }
        #expect(state.processExited(at: start.addingTimeInterval(61)).spawnAfter != nil)
        #expect(state.phase == .restarting)
    }

    @Test func retryFromFailedStartsAgainWithTheBudgetReset() {
        var state = showingOwned()
        for _ in 0..<4 { _ = state.processExited() }
        state.retry()
        #expect(state.phase == .starting)
        #expect(state.healthAnswered(.nothing, serverRunning: false) == ServerState.Effect(spawnAfter: 0))
        for _ in 0..<3 { #expect(state.processExited().spawnAfter != nil) }
    }

    @Test func somethingElseOnThePortWhileStartingFails() {
        var state = ServerState(server: server, mode: .owned)
        #expect(state.healthAnswered(.other, serverRunning: false) == ServerState.Effect(stop: true))
        #expect(state.phase == .failed(.portInUse))
    }

    @Test func anOddAnswerFromTheAppsOwnServerIsAFailedPoll() {
        var state = showingOwned()
        #expect(state.healthAnswered(.other, serverRunning: true) == ServerState.Effect(spawnAfter: 0))
        #expect(state.phase == .restarting)
    }

    @Test func aDifferAlreadyAnsweringIsShownAndItsGoingAwayStartsOne() {
        var state = ServerState(server: server, mode: .owned)
        #expect(state.healthAnswered(.differ, serverRunning: false) == ServerState.Effect(load: home))
        #expect(state.phase == .showing)
        #expect(state.healthAnswered(.nothing, serverRunning: false).spawnAfter == 0)
    }

    @Test(arguments: [Health.differ, .other, .nothing])
    func attachedModeNeverStartsAServer(_ first: Health) {
        var state = ServerState(server: server, mode: .attached)
        #expect(state.phase == .attachedWaiting)
        for health in [first, .nothing, .differ, .other, .nothing] {
            #expect(state.healthAnswered(health, serverRunning: false).spawnAfter == nil)
        }
        #expect(state.processExited().spawnAfter == nil)
        #expect(state.phase == .attachedWaiting)
    }

    @Test func aFailedNavigationWaitsWithoutStartingAnything() {
        var state = showingOwned()
        state.navigationFailed()
        #expect(state.phase == .starting)
        #expect(state.healthAnswered(.nothing, serverRunning: true) == .none)
    }

    @Test func anotherPollWhileShowingLoadsNothing() {
        var state = showingOwned()
        #expect(state.healthAnswered(.differ, serverRunning: true) == .none)
        #expect(state.phase == .showing)
    }

    @Test func aLinkWhileWaitingWinsOverTheLastPage() {
        var state = showingOwned()
        state.pageMoved(to: URL(string: "http://127.0.0.1:4460/?repo=/elsewhere")!)
        _ = state.processExited()
        #expect(state.open(repo) == nil)
        #expect(state.healthAnswered(.differ, serverRunning: true).load == repo)
        #expect(state.pending == nil)
    }

    @Test func aLinkWhileShowingLoadsAtOnce() {
        var state = showingOwned()
        #expect(state.open(repo) == repo)
    }

    @Test func onlyPagesOnTheServerAreRemembered() {
        var state = showingOwned()
        state.pageMoved(to: URL(string: "https://github.com/x/y")!)
        #expect(state.lastAddress == nil)
    }

    @Test func eachPhaseHasItsOwnMessage() {
        var owned = ServerState(server: server, mode: .owned, log: "/tmp/differ/server.log")
        #expect(owned.message == WaitingMessage(title: "Starting differ…"))
        _ = owned.healthAnswered(.differ, serverRunning: false)
        _ = owned.processExited()
        #expect(owned.message == WaitingMessage(title: "Restarting differ…"))
        for _ in 0..<3 { _ = owned.processExited() }
        #expect(
            owned.message
                == WaitingMessage(
                    title: "differ's server keeps stopping", detail: "Its log is at /tmp/differ/server.log.",
                    retry: true))

        var taken = ServerState(server: server, mode: .owned)
        _ = taken.healthAnswered(.other, serverRunning: false)
        #expect(taken.message.title == "Port 4460 is in use by another app")
        #expect(taken.message.retry)

        let attached = ServerState(server: URL(string: "http://127.0.0.1:3000")!, mode: .attached)
        #expect(attached.message == WaitingMessage(title: "Nothing is answering at http://127.0.0.1:3000"))
    }

    @Test func healthMustSayDiffer() {
        #expect(HealthProbe.isDiffer(Data(#"{"app":"differ","build":"x"}"#.utf8)))
        #expect(!HealthProbe.isDiffer(Data(#"{"app":"vite"}"#.utf8)))
        #expect(!HealthProbe.isDiffer(Data("<html>".utf8)))
    }
}

@MainActor
struct LoginAgentTests {
    private func plist(port: String) -> Data {
        Data(
            """
            <?xml version="1.0" encoding="UTF-8"?>
            <plist version="1.0"><dict>
            <key>Label</key><string>dev.differ.server</string>
            <key>EnvironmentVariables</key><dict>
            <key>PORT</key><string>\(port)</string>
            <key>HOSTNAME</key><string>127.0.0.1</string>
            </dict></dict></plist>
            """.utf8)
    }

    @Test func readsThePortTheAgentServes() {
        #expect(LoginAgent.port(fromPlist: plist(port: "4460")) == 4460)
        #expect(LoginAgent.port(fromPlist: Data("not a plist".utf8)) == nil)
    }

    @Test func bootsOutOnlyAnAgentOnTheAppsPortInOwnedMode() {
        #expect(LoginAgent.shouldBootOut(mode: .owned, appPort: 4460, agentPort: 4460))
        #expect(!LoginAgent.shouldBootOut(mode: .owned, appPort: 4460, agentPort: nil))
        #expect(!LoginAgent.shouldBootOut(mode: .owned, appPort: 4471, agentPort: 4460))
        #expect(!LoginAgent.shouldBootOut(mode: .attached, appPort: 4460, agentPort: 4460))
    }
}

@MainActor
struct FindBarContainerTests {
    @Test func theBarKeepsItsHeightAcrossHideAndShow() {
        let content = NSView()
        let container = FindBarContainer(content: content)
        container.frame = NSRect(x: 0, y: 0, width: 800, height: 600)
        let bar = NSView(frame: NSRect(x: 0, y: 0, width: 0, height: 28))
        container.findBarView = bar
        for visible in [true, false, true] {
            container.isFindBarVisible = visible
            container.layout()
            #expect(bar.frame.height == 28)
            #expect(bar.isHidden == !visible)
            #expect(content.frame.height == (visible ? 572 : 600))
        }
    }
}
