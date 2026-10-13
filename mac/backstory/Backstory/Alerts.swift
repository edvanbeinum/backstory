import AppKit

@MainActor
func tell(_ title: String, _ detail: String, on window: NSWindow?) async {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = detail
    _ = await show(alert, on: window)
}

/// Shows `alert` as a sheet on `window`, or on its own when there's no window.
@MainActor
func show(_ alert: NSAlert, on window: NSWindow?) async -> NSApplication.ModalResponse {
    guard let window else { return alert.runModal() }
    return await withCheckedContinuation { done in
        alert.beginSheetModal(for: window) { done.resume(returning: $0) }
    }
}
