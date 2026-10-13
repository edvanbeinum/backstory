import Cocoa
import ServiceManagement
import Sparkle

@main
class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    @IBOutlet var window: NSWindow!

    private var windowController: MainWindowController!

    // AppKit reads launch arguments as defaults, so `--args -serverURL
    // http://127.0.0.1:3000` attaches the app to a dev server, `-port` and
    // `-home` keep the smoke test off the user's port and store, and
    // `-feedURL` with `-checkForUpdates` points it at a local appcast.
    private let defaults = UserDefaults.standard

    private lazy var port: Int = {
        let port = defaults.integer(forKey: "port")
        return port > 0 ? port : 4460
    }()

    private lazy var home: URL =
        defaults.string(forKey: "home").map { URL(fileURLWithPath: $0) }
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".backstory")

    private lazy var attachedURL: URL? = defaults.string(forKey: "serverURL").flatMap { URL(string: $0) }

    private lazy var serverProcess: ServerProcess? = {
        guard attachedURL == nil,
            let launch = ServerProcess.Launch.inBundle(.main, port: port, home: home)
        else { return nil }
        return ServerProcess(launch)
    }()

    private lazy var server: URL = attachedURL ?? URL(string: "http://127.0.0.1:\(port)")!

    private lazy var updaterController = SPUStandardUpdaterController(
        startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)

    private lazy var probingForUpdate = defaults.bool(forKey: "checkForUpdates")

    // Set up here rather than in didFinishLaunching: a link that launches the
    // app arrives through application(_:open:) before that.
    func applicationWillFinishLaunching(_ notification: Notification) {
        windowController = MainWindowController(
            window: window,
            server: server,
            serverProcess: serverProcess,
            inspectable: attachedURL != nil
        )
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        updaterController.startUpdater()
        if probingForUpdate {
            updaterController.updater.checkForUpdateInformation()
            return
        }
        windowController.showWindow(nil)
        windowController.startPolling()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard serverProcess != nil else { return .terminateNow }
        Task {
            await windowController.shutDown()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            if let address = RepoLink.address(for: url, server: server) {
                windowController.open(address)
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { windowController.showWindow(nil) }
        return true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        return true
    }

    @IBAction func openRepo(_ sender: Any?) {
        windowController.chooseRepo()
    }

    @IBAction func showSetup(_ sender: Any?) {
        windowController.open(RepoLink.setupAddress(server: server))
    }

    /// Starts the app at login, which keeps the server up for live updates
    /// with no window open, as the old login agent did.
    @IBAction func toggleOpenAtLogin(_ sender: Any?) {
        let app = SMAppService.mainApp
        do {
            if app.status == .enabled { try app.unregister() } else { try app.register() }
        } catch {
            NSLog("Backstory: couldn't change Open at Login: \(error)")
        }
    }

    @IBAction func checkForUpdates(_ sender: Any?) {
        updaterController.checkForUpdates(sender)
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(toggleOpenAtLogin(_:)) {
            menuItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        }
        if menuItem.action == #selector(checkForUpdates(_:)) {
            return updaterController.updater.canCheckForUpdates
        }
        return true
    }
}

/// Answers `-checkForUpdates` with one line the smoke test reads, then quits,
/// so the feed, the key and the delegate are proven with no download and no
/// dialog.
extension AppDelegate: SPUUpdaterDelegate {
    func feedURLString(for updater: SPUUpdater) -> String? {
        defaults.string(forKey: "feedURL")
    }

    func updaterShouldPromptForPermissionToCheck(forUpdates updater: SPUUpdater) -> Bool {
        !probingForUpdate
    }

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        if probingForUpdate { NSLog("Backstory: update \(item.displayVersionString) available") }
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: any Error) {
        if probingForUpdate { NSLog("Backstory: no update") }
    }

    func updater(
        _ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: (any Error)?
    ) {
        guard probingForUpdate else { return }
        if let error = error as NSError?, error.code != Int(SUError.noUpdateError.rawValue) {
            NSLog("Backstory: update check failed: \(error)")
        }
        NSApp.terminate(nil)
    }
}
