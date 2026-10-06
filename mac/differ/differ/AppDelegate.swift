import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    @IBOutlet var window: NSWindow!

    private var windowController: MainWindowController!

    /// The login agent's address. AppKit reads launch arguments as defaults, so
    /// `--args -serverURL http://127.0.0.1:3000` points the app at a dev server.
    private let server: URL = {
        if let override = UserDefaults.standard.string(forKey: "serverURL"),
            let url = URL(string: override)
        {
            return url
        }
        return URL(string: "http://127.0.0.1:4460")!
    }()

    // Set up here rather than in didFinishLaunching: a link that launches the
    // app arrives through application(_:open:) before that.
    func applicationWillFinishLaunching(_ notification: Notification) {
        windowController = MainWindowController(
            window: window,
            server: server,
            inspectable: UserDefaults.standard.string(forKey: "serverURL") != nil
        )
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        windowController.showWindow(nil)
        windowController.startPolling()
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
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Open Repo"
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        windowController.open(RepoLink.address(forRepo: folder.standardizedFileURL.path, server: server))
    }
}
