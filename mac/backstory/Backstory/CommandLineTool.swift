import AppKit

/// Backstory → Install Command Line Tool…: links `/usr/local/bin/backstory`
/// to the command in the app's bundle, so `backstory` works in a terminal, and
/// fixes or removes that link.
@MainActor
enum CommandLineTool {
    static let link = "/usr/local/bin/backstory"

    enum State: Equatable {
        case missing
        case current
        /// A link to the command in some other Backstory.app, or one that has
        /// moved, carrying where it points.
        case stale(String)
        /// Anything else at the link's path, said in words.
        case other(String)
    }

    struct Cancelled: Error {}

    struct Failed: LocalizedError {
        let errorDescription: String?
    }

    nonisolated static func state(link: String, script: String) -> State {
        let files = FileManager.default
        guard let attributes = try? files.attributesOfItem(atPath: link) else { return .missing }
        guard attributes[.type] as? FileAttributeType == .typeSymbolicLink,
            let destination = try? files.destinationOfSymbolicLink(atPath: link)
        else {
            return .other(attributes[.type] as? FileAttributeType == .typeDirectory ? "a folder" : "a file")
        }
        let target = URL(
            fileURLWithPath: destination,
            relativeTo: URL(fileURLWithPath: link).deletingLastPathComponent()
        ).standardizedFileURL
        if target.resolvingSymlinksInPath().path == URL(fileURLWithPath: script).resolvingSymlinksInPath().path {
            return .current
        }
        if target.path.hasSuffix("/Contents/Resources/bin/backstory") { return .stale(target.path) }
        return .other("a link to \(target.path)")
    }

    /// Links `link` to `script`, replacing whatever is there; through
    /// `asAdmin` when the folder it goes in can't be written by this user.
    static func install(link: String, script: String, asAdmin: (String) throws -> Void) throws {
        let folder = (link as NSString).deletingLastPathComponent
        guard canWrite(into: folder) else {
            return try asAdmin("mkdir -p \(quoted(folder)) && ln -sfh \(quoted(script)) \(quoted(link))")
        }
        let files = FileManager.default
        try files.createDirectory(atPath: folder, withIntermediateDirectories: true)
        if (try? files.attributesOfItem(atPath: link)) != nil { try files.removeItem(atPath: link) }
        try files.createSymbolicLink(atPath: link, withDestinationPath: script)
    }

    static func remove(link: String, asAdmin: (String) throws -> Void) throws {
        let folder = (link as NSString).deletingLastPathComponent
        guard canWrite(into: folder) else { return try asAdmin("rm -f \(quoted(link))") }
        try FileManager.default.removeItem(atPath: link)
    }

    /// Whether the nearest folder that exists on the way to `folder` can be
    /// written, which is all creating the rest of it and the link needs.
    private nonisolated static func canWrite(into folder: String) -> Bool {
        var path = folder
        while !FileManager.default.fileExists(atPath: path) && path != "/" {
            path = (path as NSString).deletingLastPathComponent
        }
        return FileManager.default.isWritableFile(atPath: path)
    }

    private nonisolated static func quoted(_ path: String) -> String {
        "'" + path.replacingOccurrences(of: "'", with: #"'\''"#) + "'"
    }

    /// Runs `command` as root after the system's password prompt. It runs in
    /// this process rather than through `osascript`, so the prompt names
    /// Backstory.
    static func runAsAdmin(_ command: String) throws {
        let literal =
            "\""
            + command.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
            + "\""
        var error: NSDictionary?
        let script = NSAppleScript(source: "do shell script \(literal) with administrator privileges")
        _ = script?.executeAndReturnError(&error)
        guard let error else { return }
        if error[NSAppleScript.errorNumber] as? Int == -128 { throw Cancelled() }
        throw Failed(errorDescription: error[NSAppleScript.errorMessage] as? String ?? "The command failed.")
    }

    /// Says what's at `link` in a sheet on `window` and installs, fixes or
    /// removes it if the user agrees; returns once the alerts are done.
    static func run(from window: NSWindow?) async {
        let bundle = Bundle.main
        guard ClaudeSetup.isStableLocation(bundle.bundleURL.path) else {
            return await tell(
                "Move Backstory to Applications first",
                "The backstory command would link to Backstory where it is now, which stops working once it's moved or the disk image is ejected.",
                on: window)
        }
        guard let script = bundle.resourceURL?.appendingPathComponent("bin/backstory").path,
            FileManager.default.fileExists(atPath: script)
        else {
            return await tell(
                "The backstory command isn't in this build",
                "Build the app with npm run mac:build, which puts it in the bundle.", on: window)
        }

        let alert = NSAlert()
        switch state(link: link, script: script) {
        case .missing:
            alert.messageText = "Install the backstory command?"
            alert.informativeText =
                "This links \(link) to the command in Backstory, so typing backstory in a terminal opens that folder's repo. It may ask for your password."
            alert.addButton(withTitle: "Install")
        case .stale(let old):
            alert.messageText = "The backstory command points to a Backstory that isn't here any more"
            alert.informativeText = "\(link) links to \(old). Fix it to link to this copy of Backstory."
            alert.addButton(withTitle: "Fix")
        case .other(let what):
            alert.messageText = "\(link) is already something else"
            alert.informativeText = "It's \(what). Replace it with a link to the command in Backstory?"
            alert.addButton(withTitle: "Replace")
        case .current:
            alert.messageText = "The backstory command is installed"
            alert.informativeText = "\(link) links to the command in this copy of Backstory."
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Remove")
            guard await show(alert, on: window) == .alertSecondButtonReturn else { return }
            do {
                try remove(link: link, asAdmin: runAsAdmin)
            } catch is Cancelled {
            } catch {
                await tell("Couldn't remove the backstory command", error.localizedDescription, on: window)
            }
            return
        }
        alert.addButton(withTitle: "Cancel")
        guard await show(alert, on: window) == .alertFirstButtonReturn else { return }
        do {
            try install(link: link, script: script, asAdmin: runAsAdmin)
        } catch is Cancelled {
            return
        } catch {
            return await tell("Couldn't install the backstory command", error.localizedDescription, on: window)
        }
        if state(link: link, script: script) != .current {
            await tell(
                "The backstory command didn't install",
                "\(link) still doesn't link to the command in Backstory.", on: window)
        }
    }
}
