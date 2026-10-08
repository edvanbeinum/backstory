import Cocoa
import ServiceManagement

@main
class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    @IBOutlet var window: NSWindow!

    private var windowController: MainWindowController!

    // AppKit reads launch arguments as defaults, so `--args -serverURL
    // http://127.0.0.1:3000` attaches the app to a dev server, and `-port` and
    // `-home` keep the smoke test off the user's port and store.
    private let defaults = UserDefaults.standard

    private lazy var port: Int = {
        let port = defaults.integer(forKey: "port")
        return port > 0 ? port : 4460
    }()

    private lazy var home: URL = {
        let home =
            defaults.string(forKey: "home").map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".backstory")
        ServerProcess.Launch.moveOldHome(to: home)
        return home
    }()

    private lazy var attachedURL: URL? = defaults.string(forKey: "serverURL").flatMap { URL(string: $0) }

    private lazy var serverProcess: ServerProcess? = {
        guard attachedURL == nil,
            let launch = ServerProcess.Launch.inBundle(.main, port: port, home: home)
        else { return nil }
        return ServerProcess(launch)
    }()

    private lazy var server: URL = attachedURL ?? URL(string: "http://127.0.0.1:\(port)")!

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
        windowController.showWindow(nil)
        Task {
            await bootOutLoginAgent()
            windowController.startPolling()
        }
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

    /// Removes the login agent the old `differ` command used to install, when
    /// it serves the app's port: its `KeepAlive` would hold the port against
    /// the app, and nothing else removes it any more.
    private func bootOutLoginAgent() async {
        let plist = LoginAgent.plist
        let agentPort = (try? Data(contentsOf: plist)).flatMap(LoginAgent.port(fromPlist:))
        guard
            LoginAgent.shouldBootOut(
                mode: serverProcess == nil ? .attached : .owned, appPort: port, agentPort: agentPort)
        else { return }
        let launchctl = Process()
        launchctl.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        launchctl.arguments = ["bootout", "gui/\(getuid())/\(LoginAgent.label)"]
        launchctl.standardOutput = FileHandle.nullDevice
        launchctl.standardError = FileHandle.nullDevice
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            launchctl.terminationHandler = { _ in done.resume() }
            do { try launchctl.run() } catch { done.resume() }
        }
        try? FileManager.default.removeItem(at: plist)
        NSLog("Backstory: removed the login agent \(LoginAgent.label); the app runs the server now")
    }

    @IBAction func openRepo(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Open Repo"
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        windowController.open(RepoLink.address(forRepo: folder.standardizedFileURL.path, server: server))
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

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(toggleOpenAtLogin(_:)) {
            menuItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        }
        return true
    }
}
