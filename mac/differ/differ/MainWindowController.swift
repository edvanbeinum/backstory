import AppKit
import WebKit

/// The one window: differ's page in a web view while the server answers, the
/// waiting view while it doesn't.
final class MainWindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate {
    private var state: ServerState
    private let webView: WKWebView
    private let waitingView: WaitingView
    private var polling: Task<Void, Never>?

    init(window: NSWindow, server: URL, inspectable: Bool) {
        state = ServerState(server: server)
        webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        waitingView = WaitingView(server: server)
        super.init(window: window)

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = inspectable

        let content = NSView()
        for view in [webView, waitingView] as [NSView] {
            view.frame = content.bounds
            view.autoresizingMask = [.width, .height]
            content.addSubview(view)
        }
        window.contentView = content
        window.title = "differ"
        window.setContentSize(NSSize(width: 1280, height: 820))
        window.center()
        window.setFrameAutosaveName("differ")
        show(.waiting)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    func startPolling() {
        polling = Task { [weak self] in
            while let server = self?.state.server {
                let isDiffer = await HealthProbe.check(server)
                guard let self else { return }
                self.healthAnswered(isDiffer: isDiffer)
                // Polls fast while waiting, so the page comes up soon after
                // the server does, and slower once it's up, only to notice the
                // server going away.
                let delay: Duration = state.phase == .waiting ? .seconds(1) : .seconds(3)
                try? await Task.sleep(for: delay)
            }
        }
    }

    func open(_ address: URL) {
        showWindow(nil)
        NSApp.activate()
        if let now = state.open(address) { webView.load(URLRequest(url: now)) }
    }

    private func healthAnswered(isDiffer: Bool) {
        let load = state.healthAnswered(isDiffer: isDiffer)
        show(state.phase)
        if let load { webView.load(URLRequest(url: load)) }
    }

    private func show(_ phase: ServerState.Phase) {
        webView.isHidden = phase != .showing
        waitingView.isHidden = phase == .showing
    }

    private func navigationFailed(_ error: Error) {
        let error = error as NSError
        // A navigation replaced by another, or one the policy below cancelled,
        // fails too; neither means the server has gone.
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
        if error.domain == "WebKitErrorDomain" && error.code == 102 { return }
        state.navigationFailed()
        show(state.phase)
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
}
