import AppKit
import WebKit

/// The one window: Backstory's page in a web view while a Backstory answers, the
/// waiting view while it doesn't. In owned mode it also starts the server and
/// restarts it, as `ServerState` decides.
final class MainWindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate,
    WKScriptMessageHandler
{
    private var state: ServerState
    private let serverProcess: ServerProcess?
    private let webView: DropWebView
    private let page: FindBarContainer
    private let textFinder = NSTextFinder()
    private var waitingView: WaitingView!
    private var polling: Task<Void, Never>?
    private var urlObservation: NSKeyValueObservation?

    init(window: NSWindow, server: URL, serverProcess: ServerProcess?, inspectable: Bool) {
        self.serverProcess = serverProcess
        state = ServerState(
            server: server,
            mode: serverProcess == nil ? .attached : .owned,
            log: serverProcess?.launch.log.path
        )
        webView = DropWebView(frame: .zero, configuration: WKWebViewConfiguration())
        page = FindBarContainer(content: webView)
        super.init(window: window)
        textFinder.client = webView
        textFinder.findBarContainer = page
        textFinder.isIncrementalSearchingEnabled = true
        // Leave the page undimmed: when the bar fails to appear on a later Cmd-F,
        // a dimmed page with no bar to dismiss it traps the window.
        textFinder.incrementalSearchingShouldDimContentView = false
        webView.textFinder = textFinder
        waitingView = WaitingView { [weak self] in self?.retry() }
        webView.onFolderDrop = { [weak self] folder in
            guard let self else { return }
            self.open(RepoLink.address(forRepo: folder.standardizedFileURL.path, server: self.state.server))
        }

        webView.navigationDelegate = self
        webView.uiDelegate = self
        // The page posts "openRepo" here; its presence is also how the page
        // knows it's in the Mac app and offers Open Repo….
        webView.configuration.userContentController.add(self, name: "backstory")
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = inspectable
        urlObservation = webView.observe(\.url) { [weak self] webView, _ in
            MainActor.assumeIsolated {
                if let url = webView.url { self?.state.pageMoved(to: url) }
            }
        }
        serverProcess?.onExit = { [weak self] in
            guard let self else { return }
            self.apply(self.state.processExited())
        }

        let content = NSView()
        for view in [page, waitingView!] as [NSView] {
            view.frame = content.bounds
            view.autoresizingMask = [.width, .height]
            content.addSubview(view)
        }
        window.contentView = content
        window.title = "Backstory"
        window.setContentSize(NSSize(width: 1280, height: 820))
        window.center()
        window.setFrameAutosaveName("Backstory")
        render()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    func startPolling() {
        polling = Task { [weak self] in
            while let server = self?.state.server {
                let health = await HealthProbe.check(server)
                guard let self, !Task.isCancelled else { return }
                self.apply(
                    self.state.healthAnswered(
                        health, serverRunning: self.serverProcess?.isRunningOrScheduled ?? false))
                // Polls fast while waiting, so the page comes up soon after
                // the server does, and slower once it's up, only to notice the
                // server going away.
                let delay: Duration = state.phase == .showing ? .seconds(3) : .seconds(1)
                try? await Task.sleep(for: delay)
            }
        }
    }

    /// Stops polling and the server, for the app quitting.
    func shutDown() async {
        polling?.cancel()
        await serverProcess?.stopAndWait(timeout: 2)
    }

    func open(_ address: URL) {
        showWindow(nil)
        NSApp.activate()
        if let now = state.open(address) { webView.load(URLRequest(url: now)) }
    }

    /// File → Open Repo…, and the empty inbox's Open Repo… button.
    func chooseRepo() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Open Repo"
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        open(RepoLink.address(forRepo: folder.standardizedFileURL.path, server: state.server))
    }

    private func apply(_ effect: ServerState.Effect) {
        if effect.stop { serverProcess?.stop() }
        if let delay = effect.spawnAfter { serverProcess?.start(after: delay) }
        if let load = effect.load {
            // A Backstory answering before a scheduled restart means one the app
            // didn't start has the port, and a second would only fail to bind.
            serverProcess?.cancelScheduled()
            webView.load(URLRequest(url: load))
        }
        render()
    }

    private func render() {
        page.isHidden = state.phase != .showing
        waitingView.isHidden = state.phase == .showing
        waitingView.show(state.message)
    }

    private func retry() {
        state.retry()
        render()
    }

    private func navigationFailed(_ error: Error) {
        let error = error as NSError
        // A navigation replaced by another, or one the policy below cancelled,
        // fails too; neither means the server has gone.
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
        if error.domain == "WebKitErrorDomain" && error.code == 102 { return }
        state.navigationFailed()
        render()
    }

    private func isServer(_ url: URL) -> Bool {
        url.scheme == state.server.scheme && url.host == state.server.host
            && url.port == state.server.port
    }

    // MARK: - Menu actions

    @IBAction func reloadPage(_ sender: Any?) {
        if state.phase == .showing { webView.reload() }
    }

    @IBAction func goBack(_ sender: Any?) {
        webView.goBack()
    }

    @IBAction func goForward(_ sender: Any?) {
        webView.goForward()
    }

    @IBAction func zoomIn(_ sender: Any?) {
        webView.pageZoom = min(webView.pageZoom * 1.1, 3)
    }

    @IBAction func zoomOut(_ sender: Any?) {
        webView.pageZoom = max(webView.pageZoom / 1.1, 0.5)
    }

    @IBAction func actualSize(_ sender: Any?) {
        webView.pageZoom = 1
    }

    /// Find while the page itself doesn't have focus; the web view takes it
    /// when it does.
    override func performTextFinderAction(_ sender: Any?) {
        guard state.phase == .showing, let action = TextFinderAction.from(sender) else { return }
        textFinder.performAction(action)
    }

    // MARK: - WKNavigationDelegate

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        guard navigationAction.targetFrame?.isMainFrame == true,
            let url = navigationAction.request.url,
            ["http", "https", "mailto"].contains(url.scheme),
            !isServer(url)
        else { return .allow }
        NSWorkspace.shared.open(url)
        return .cancel
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        textFinder.noteClientStringWillChange()
    }

    func webView(
        _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        navigationFailed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
    ) {
        guard message.frameInfo.isMainFrame,
            let url = message.frameInfo.request.url, isServer(url),
            message.body as? String == "openRepo"
        else { return }
        chooseRepo()
    }

    // MARK: - WKUIDelegate

    /// Hands `target="_blank"` links and `window.open` to the default browser;
    /// a bare web view would otherwise drop them.
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isServer(url) { webView.load(navigationAction.request) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    /// Shows `window.confirm` as a sheet; without this a web view answers
    /// false silently, and the page's Redraft button does nothing.
    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        guard let window else { return completionHandler(alert.runModal() == .alertFirstButtonReturn) }
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
}
