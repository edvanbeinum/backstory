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

    var isFindBarVisible = false {
        didSet {
            findBarView?.isHidden = !isFindBarVisible
            needsLayout = true
        }
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

    override func layout() {
        super.layout()
        let barHeight = isFindBarVisible ? findBarView?.frame.height ?? 0 : 0
        findBarView?.frame = NSRect(x: 0, y: bounds.height - barHeight, width: bounds.width, height: barHeight)
        content.frame = NSRect(x: 0, y: 0, width: bounds.width, height: bounds.height - barHeight)
    }
}
