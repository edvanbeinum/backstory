import AppKit

/// Native rather than a page, so it can't be mistaken for differ's own UI
/// while the server is starting, restarting or failing.
final class WaitingView: NSView {
    private let title = NSTextField(labelWithString: "")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let spinner = NSProgressIndicator()
    private let retryButton = NSButton(title: "Retry", target: nil, action: nil)
    private let onRetry: () -> Void

    init(onRetry: @escaping () -> Void) {
        self.onRetry = onRetry
        super.init(frame: .zero)

        title.font = .systemFont(ofSize: 20, weight: .semibold)
        title.alignment = .center
        detail.alignment = .center
        detail.textColor = .secondaryLabelColor
        detail.preferredMaxLayoutWidth = 420
        detail.isSelectable = true
        spinner.style = .spinning
        spinner.controlSize = .small
        retryButton.target = self
        retryButton.action = #selector(retry)
        retryButton.keyEquivalent = "\r"

        let stack = NSStackView(views: [title, detail, spinner, retryButton])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    func show(_ message: WaitingMessage) {
        title.stringValue = message.title
        detail.stringValue = message.detail ?? ""
        detail.isHidden = message.detail == nil
        retryButton.isHidden = !message.retry
        spinner.isHidden = message.retry
        if message.retry { spinner.stopAnimation(nil) } else { spinner.startAnimation(nil) }
    }

    @objc private func retry() {
        onRetry()
    }
}
