import AppKit

/// Holds AppKit's find bar above the page. The bar needs a container to sit
/// in; a scroll view is the usual one, and the web view isn't in one.
final class FindBarContainer: NSView, NSTextFinderBarContainer {
    let content: NSView

    var findBarView: NSView? {
        didSet {
            oldValue?.removeFromSuperview()
            if let findBarView { addSubview(findBarView) }
            needsLayout = true
        }
    }

    // Show the bar whenever the container has one, and drop it on hide. The
    // finder hands the bar over on the first Cmd-F without setting this to
    // true, and on later ones sets it to true only after handing the bar back
    // to a container that has none; a container that keeps the bar and hides
    // it never shows it again.
    var isFindBarVisible: Bool {
        get { findBarView != nil }
        set { if !newValue { findBarView = nil } }
    }

    init(content: NSView) {
        self.content = content
        super.init(frame: .zero)
        addSubview(content)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    func findBarViewDidChangeHeight() {
        needsLayout = true
    }

    func contentView() -> NSView? {
        content
    }

    // Keep the bar's own height: AppKit sizes the bar once and reads that
    // height back when it hands the bar over again, so a frame collapsed to
    // zero leaves every later Cmd-F with an invisible bar.
    override func layout() {
        super.layout()
        let barHeight = findBarView?.frame.height ?? 0
        findBarView?.frame = NSRect(x: 0, y: bounds.height - barHeight, width: bounds.width, height: barHeight)
        content.frame = NSRect(x: 0, y: 0, width: bounds.width, height: bounds.height - barHeight)
    }
}
