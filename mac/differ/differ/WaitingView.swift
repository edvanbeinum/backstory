import AppKit

/// What the window shows while differ's server doesn't answer: native, so it
/// can't be mistaken for differ's own page.
final class WaitingView: NSView {
    init(server: URL) {
        super.init(frame: .zero)

        let title = NSTextField(labelWithString: "differ's server isn't running")
        title.font = .systemFont(ofSize: 20, weight: .semibold)

        let hint = NSTextField(
            wrappingLabelWithString:
                "Start it from a terminal in any checkout. This window opens differ as soon as it answers on \(server.absoluteString)."
        )
        hint.alignment = .center
        hint.textColor = .secondaryLabelColor
        hint.preferredMaxLayoutWidth = 420

        let command = NSTextField(labelWithString: "differ")
        command.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        command.isSelectable = true

        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)

        let stack = NSStackView(views: [title, hint, command, spinner])
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
}
