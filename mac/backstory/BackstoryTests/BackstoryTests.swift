import AppKit
import Foundation
import Testing

@testable import Backstory

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
    @Test func openLinkLoadsTheRepoOnTheServer() {
        let link = URL(string: "backstory://open?repo=/Users/me/code/app")!
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
        let link = URL(string: "backstory://open?repo=\(encoded)")!
        #expect(repoParam(RepoLink.address(for: link, server: server)!) == repo)
    }

    @Test func folderFileUrlMapsToTheSameAddress() {
        let folder = URL(fileURLWithPath: "/Users/me/code/app", isDirectory: true)
        #expect(
            RepoLink.address(for: folder, server: server)
                == RepoLink.address(for: URL(string: "backstory://open?repo=/Users/me/code/app")!, server: server))
    }

    @Test(arguments: [
        "https://open?repo=/Users/me/code/app",
        "backstory://close?repo=/Users/me/code/app",
        "backstory://open",
        "backstory://open?path=/Users/me/code/app",
        "backstory://open?repo=code/app",
        "other://open?repo=/Users/me/code/app",
    ])
    func ignoresAnythingElse(_ link: String) {
        #expect(RepoLink.address(for: URL(string: link)!, server: server) == nil)
    }

    @Test func overriddenServerKeepsItsPort() {
        let dev = URL(string: "http://127.0.0.1:3000")!
        #expect(
            RepoLink.address(forRepo: "/r", server: dev).absoluteString == "http://127.0.0.1:3000/?repo=/r")
    }

    @Test func setUpBackstoryLoadsTheChecklistOnTheServer() {
        #expect(RepoLink.setupAddress(server: server).absoluteString == "http://127.0.0.1:4460/?setup=1")
    }
}

private let home = URL(string: "http://127.0.0.1:4460/")!

/// An owned-mode state showing the server the app started.
private func showingOwned() -> ServerState {
    var state = ServerState(server: server, mode: .owned, log: "/tmp/backstory/server.log")
    _ = state.healthAnswered(.nothing, serverRunning: false)
    _ = state.healthAnswered(.backstory, serverRunning: true)
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
        #expect(state.healthAnswered(.backstory, serverRunning: true) == ServerState.Effect(load: repo))
        #expect(state.phase == .showing)
    }

    @Test func aBusyServerMissesTwoPollsAndTheThirdRestartsIt() {
        var state = showingOwned()
        for _ in 0..<2 {
            #expect(state.healthAnswered(.nothing, serverRunning: true) == .none)
            #expect(state.phase == .showing)
        }
        #expect(state.healthAnswered(.nothing, serverRunning: true) == ServerState.Effect(spawnAfter: 0))
        #expect(state.phase == .restarting)
    }

    @Test func anAnswerBetweenMissedPollsStartsTheCountAgain() {
        var state = showingOwned()
        for _ in 0..<2 { _ = state.healthAnswered(.nothing, serverRunning: true) }
        #expect(state.healthAnswered(.backstory, serverRunning: true) == .none)
        for _ in 0..<2 { #expect(state.healthAnswered(.nothing, serverRunning: true) == .none) }
        #expect(state.phase == .showing)
    }

    @Test func ownedModeStartsTheServerWhenNothingAnswers() {
        var state = ServerState(server: server, mode: .owned)
        #expect(state.phase == .starting)
        #expect(state.healthAnswered(.nothing, serverRunning: false) == ServerState.Effect(spawnAfter: 0))
        #expect(state.healthAnswered(.nothing, serverRunning: true) == .none)
        #expect(state.phase == .starting)
        #expect(state.healthAnswered(.backstory, serverRunning: true) == ServerState.Effect(load: home))
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
        for _ in 0..<2 { #expect(state.healthAnswered(.other, serverRunning: true) == .none) }
        #expect(state.healthAnswered(.other, serverRunning: true) == ServerState.Effect(spawnAfter: 0))
        #expect(state.phase == .restarting)
    }

    @Test func aBackstoryAlreadyAnsweringIsShownAndItsGoingAwayStartsOne() {
        var state = ServerState(server: server, mode: .owned)
        #expect(state.healthAnswered(.backstory, serverRunning: false) == ServerState.Effect(load: home))
        #expect(state.phase == .showing)
        #expect(state.healthAnswered(.nothing, serverRunning: false).spawnAfter == 0)
    }

    @Test(arguments: [Health.backstory, .other, .nothing])
    func attachedModeNeverStartsAServer(_ first: Health) {
        var state = ServerState(server: server, mode: .attached)
        #expect(state.phase == .attachedWaiting)
        for health in [first, .nothing, .backstory, .other, .nothing] {
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
        #expect(state.healthAnswered(.backstory, serverRunning: true) == .none)
        #expect(state.phase == .showing)
    }

    @Test func aLinkWhileWaitingWinsOverTheLastPage() {
        var state = showingOwned()
        state.pageMoved(to: URL(string: "http://127.0.0.1:4460/?repo=/elsewhere")!)
        _ = state.processExited()
        #expect(state.open(repo) == nil)
        #expect(state.healthAnswered(.backstory, serverRunning: true).load == repo)
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
        var owned = ServerState(server: server, mode: .owned, log: "/tmp/backstory/server.log")
        #expect(owned.message == WaitingMessage(title: "Starting Backstory…"))
        _ = owned.healthAnswered(.backstory, serverRunning: false)
        _ = owned.processExited()
        #expect(owned.message == WaitingMessage(title: "Restarting Backstory…"))
        for _ in 0..<3 { _ = owned.processExited() }
        #expect(
            owned.message
                == WaitingMessage(
                    title: "Backstory's server keeps stopping", detail: "Its log is at /tmp/backstory/server.log.",
                    retry: true))

        var taken = ServerState(server: server, mode: .owned)
        _ = taken.healthAnswered(.other, serverRunning: false)
        #expect(taken.message.title == "Port 4460 is in use by another app")
        #expect(taken.message.retry)

        let attached = ServerState(server: URL(string: "http://127.0.0.1:3000")!, mode: .attached)
        #expect(attached.message == WaitingMessage(title: "Nothing is answering at http://127.0.0.1:3000"))
    }

    @Test func healthMustSayBackstory() {
        #expect(HealthProbe.isBackstory(Data(#"{"app":"backstory","build":"x"}"#.utf8)))
        #expect(!HealthProbe.isBackstory(Data(#"{"app":"other","build":"x"}"#.utf8)))
        #expect(!HealthProbe.isBackstory(Data(#"{"app":"vite"}"#.utf8)))
        #expect(!HealthProbe.isBackstory(Data("<html>".utf8)))
    }
}

struct ClaudeSetupTests {
    @Test(arguments: [
        "/Volumes/Backstory/Backstory.app",
        "/private/var/folders/xy/abc/T/AppTranslocation/1234-5678/d/Backstory.app",
    ])
    func aHookIsNeverWrittenFromWhereTheAppWontStay(_ path: String) {
        #expect(!ClaudeSetup.isStableLocation(path))
    }

    @Test func applicationsIsAStableLocation() {
        #expect(ClaudeSetup.isStableLocation("/Applications/Backstory.app"))
    }
}

/// A temp dir holding a fake bundled command, `script`, and the path `link`
/// that stands in for `/usr/local/bin/backstory`, in a folder not made yet.
private struct CommandLineToolPlace {
    let root: URL
    let script: String
    let link: String

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "backstory cli 'test' \(UUID().uuidString)")
        script = try Self.bundle(in: root, named: "Backstory.app")
        link = root.appendingPathComponent("usr local/bin/backstory").path
    }

    /// Makes `…/<name>/Contents/Resources/bin/backstory` under `root`.
    static func bundle(in root: URL, named name: String) throws -> String {
        let bin = root.appendingPathComponent("\(name)/Contents/Resources/bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let script = bin.appendingPathComponent("backstory").path
        FileManager.default.createFile(atPath: script, contents: Data("#!/bin/sh\n".utf8))
        return script
    }

    func lock(_ path: String) throws {
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: path)
    }

    /// Stands in for the password prompt: gives write access back, as root
    /// would have it, and runs the command with `sh`.
    func runAsRoot(unlocking path: String) -> (String) throws -> Void {
        { command in
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = ["-c", command]
            try process.run()
            process.waitUntilExit()
            #expect(process.terminationStatus == 0)
        }
    }

    func cleanUp() {
        if let paths = FileManager.default.enumerator(atPath: root.path) {
            for case let path as String in paths {
                try? FileManager.default.setAttributes(
                    [.posixPermissions: 0o755], ofItemAtPath: root.appendingPathComponent(path).path)
            }
        }
        try? FileManager.default.removeItem(at: root)
    }
}

private func neverAsAdmin(_ command: String) throws {
    Issue.record("asked for a password to run \(command)")
}

@MainActor
struct CommandLineToolTests {
    @Test func installMakesTheFolderAndLinksTheCommandWithoutAPassword() throws {
        let place = try CommandLineToolPlace()
        defer { place.cleanUp() }
        #expect(CommandLineTool.state(link: place.link, script: place.script) == .missing)

        try CommandLineTool.install(link: place.link, script: place.script, asAdmin: neverAsAdmin)

        #expect(CommandLineTool.state(link: place.link, script: place.script) == .current)
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: place.link) == place.script)
    }

    @Test func aFolderThisUserCantWriteGoesThroughThePasswordPrompt() throws {
        let place = try CommandLineToolPlace()
        defer { place.cleanUp() }
        let locked = place.root.appendingPathComponent("usr local").path
        try FileManager.default.createDirectory(atPath: locked, withIntermediateDirectories: true)
        try place.lock(locked)
        var commands: [String] = []
        let asRoot = place.runAsRoot(unlocking: locked)

        try CommandLineTool.install(link: place.link, script: place.script) { command in
            commands.append(command)
            #expect(!FileManager.default.fileExists(atPath: (place.link as NSString).deletingLastPathComponent))
            try asRoot(command)
        }

        #expect(commands.count == 1)
        #expect(commands.first?.hasPrefix("mkdir -p '") == true)
        #expect(commands.first?.contains("ln -sfh '") == true)
        #expect(CommandLineTool.state(link: place.link, script: place.script) == .current)
    }

    @Test func aLinkToAnAppThatMovedIsStaleAndInstallFixesIt() throws {
        let place = try CommandLineToolPlace()
        defer { place.cleanUp() }
        let old = try CommandLineToolPlace.bundle(in: place.root, named: "Old/Backstory.app")
        try CommandLineTool.install(link: place.link, script: old, asAdmin: neverAsAdmin)
        try FileManager.default.removeItem(atPath: place.root.appendingPathComponent("Old").path)

        #expect(CommandLineTool.state(link: place.link, script: place.script) == .stale(old))

        try CommandLineTool.install(link: place.link, script: place.script, asAdmin: neverAsAdmin)
        #expect(CommandLineTool.state(link: place.link, script: place.script) == .current)
    }

    @Test func aLinkToAnotherCopyOfTheAppIsStale() throws {
        let place = try CommandLineToolPlace()
        defer { place.cleanUp() }
        let other = try CommandLineToolPlace.bundle(in: place.root, named: "Elsewhere/Backstory.app")
        try CommandLineTool.install(link: place.link, script: other, asAdmin: neverAsAdmin)

        #expect(CommandLineTool.state(link: place.link, script: place.script) == .stale(other))
    }

    @Test func aFileOrALinkToAnyOtherBackstoryIsSomethingElseAndInstallReplacesIt() throws {
        let place = try CommandLineToolPlace()
        defer { place.cleanUp() }
        let checkout = place.root.appendingPathComponent("checkout/bin/backstory.mjs").path
        try CommandLineTool.install(link: place.link, script: checkout, asAdmin: neverAsAdmin)
        #expect(CommandLineTool.state(link: place.link, script: place.script) == .other("a link to \(checkout)"))
        try CommandLineTool.install(link: place.link, script: place.script, asAdmin: neverAsAdmin)
        #expect(CommandLineTool.state(link: place.link, script: place.script) == .current)

        try FileManager.default.removeItem(atPath: place.link)
        FileManager.default.createFile(atPath: place.link, contents: Data("#!/bin/sh\n".utf8))
        #expect(CommandLineTool.state(link: place.link, script: place.script) == .other("a file"))
        try CommandLineTool.install(link: place.link, script: place.script, asAdmin: neverAsAdmin)
        #expect(CommandLineTool.state(link: place.link, script: place.script) == .current)
    }

    @Test func removeTakesOutOnlyTheLink() throws {
        let place = try CommandLineToolPlace()
        defer { place.cleanUp() }
        try CommandLineTool.install(link: place.link, script: place.script, asAdmin: neverAsAdmin)

        try CommandLineTool.remove(link: place.link, asAdmin: neverAsAdmin)

        #expect(CommandLineTool.state(link: place.link, script: place.script) == .missing)
        #expect(FileManager.default.fileExists(atPath: (place.link as NSString).deletingLastPathComponent))
        #expect(FileManager.default.fileExists(atPath: place.script))
    }

    @Test func removeFromAFolderThisUserCantWriteGoesThroughThePasswordPrompt() throws {
        let place = try CommandLineToolPlace()
        defer { place.cleanUp() }
        try CommandLineTool.install(link: place.link, script: place.script, asAdmin: neverAsAdmin)
        let bin = (place.link as NSString).deletingLastPathComponent
        try place.lock(bin)
        var commands: [String] = []
        let asRoot = place.runAsRoot(unlocking: bin)

        try CommandLineTool.remove(link: place.link) { command in
            commands.append(command)
            try asRoot(command)
        }

        #expect(commands.count == 1)
        #expect(commands.first?.hasPrefix("rm -f '") == true)
        #expect(CommandLineTool.state(link: place.link, script: place.script) == .missing)
    }

    @Test func anEmptyOrMissingFolderIsMissing() throws {
        let place = try CommandLineToolPlace()
        defer { place.cleanUp() }
        #expect(CommandLineTool.state(link: place.link, script: place.script) == .missing)
        try FileManager.default.createDirectory(
            atPath: (place.link as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        #expect(CommandLineTool.state(link: place.link, script: place.script) == .missing)
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
