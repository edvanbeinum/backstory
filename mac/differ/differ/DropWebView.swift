import AppKit
import WebKit

/// The page's web view, which opens a folder dropped on the window as a repo
/// and passes any other drop to the page.
final class DropWebView: WKWebView {
    var onFolderDrop: ((URL) -> Void)?

    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        registerForDraggedTypes([.fileURL])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    private func folder(in drag: NSDraggingInfo) -> URL? {
        let urls = drag.draggingPasteboard.readObjects(
            forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
        guard let first = urls?.first,
            (try? first.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
        else { return nil }
        return first
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        folder(in: sender) != nil ? .copy : super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        folder(in: sender) != nil ? .copy : super.draggingUpdated(sender)
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        folder(in: sender) != nil ? true : super.prepareForDragOperation(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let folder = folder(in: sender) else { return super.performDragOperation(sender) }
        onFolderDrop?(folder)
        return true
    }
}
