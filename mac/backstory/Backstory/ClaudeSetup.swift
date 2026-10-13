import AppKit

/// The setup checklist's Notes to your agent button: adds Backstory's Stop hook and
/// `/backstory-review` to Claude Code, or takes them out, by running
/// `backstory setup claude` from the bundle once the user has seen what it
/// changes. The merge itself is in `bin/claude-setup.mjs`.
@MainActor
enum ClaudeSetup {
    private struct Plan: Decodable {
        let state: String
        let changes: [String]
        let message: String?
    }

    /// Whether a hook naming the app at `path` keeps working: one written
    /// from a disk image breaks the moment it's ejected, and a translocated
    /// path is gone once the app quits.
    nonisolated static func isStableLocation(_ path: String) -> Bool {
        !path.hasPrefix("/Volumes/") && !path.contains("/AppTranslocation/")
    }

    enum Action {
        case setUp, remove
    }

    /// Shows what `action` changes in a sheet on `window` and carries it out
    /// if the user agrees; returns once the alerts are done.
    static func run(_ action: Action, from window: NSWindow?) async {
        let bundle = Bundle.main
        guard isStableLocation(bundle.bundleURL.path) else {
            return await tell(
                "Move Backstory to Applications first",
                "Claude Code's hook would name Backstory where it is now, which stops working once it's moved or the disk image is ejected.",
                on: window)
        }
        guard let resources = bundle.resourceURL,
            FileManager.default.fileExists(atPath: resources.appendingPathComponent("bin/backstory").path)
        else {
            return await tell(
                "The backstory command isn't in this build",
                "Build the app with npm run mac:build, which puts it in the bundle.", on: window)
        }
        let node = bundle.bundleURL.appendingPathComponent("Contents/Helpers/node").path
        let script = resources.appendingPathComponent("bin/backstory.mjs").path
        let undo = action == .remove

        let plan: Plan
        do {
            plan = try JSONDecoder().decode(
                Plan.self,
                from: try await setup(node: node, script: script, undo ? ["--check", "--undo"] : ["--check"]))
        } catch {
            return await tell("Couldn't check Claude Code's settings", "\(error)", on: window)
        }

        if plan.state == "error" {
            return await tell("Couldn't read Claude Code's settings", plan.message ?? "", on: window)
        }
        if undo && plan.changes.isEmpty {
            return await tell("Backstory isn't set up in Claude Code", "There's nothing to remove.", on: window)
        }
        if !undo && plan.state == "current" {
            return await tell("Claude Code is already set up for Backstory", "", on: window)
        }
        let (title, button) =
            undo
            ? ("Remove Backstory from Claude Code?", "Remove")
            : ("Set up Claude Code for Backstory?", "Set Up")
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = plan.changes.map { "• \($0)" }.joined(separator: "\n")
        alert.addButton(withTitle: button)
        alert.addButton(withTitle: "Cancel")
        guard await show(alert, on: window) == .alertFirstButtonReturn else { return }
        do {
            _ = try await setup(node: node, script: script, undo ? ["--undo"] : [])
        } catch {
            await tell("Couldn't change Claude Code's settings", "\(error)", on: window)
        }
    }

    private struct Failed: Error, CustomStringConvertible {
        let description: String
    }

    /// Runs `backstory setup claude` off the main thread and returns its stdout.
    private static func setup(node: String, script: String, _ args: [String]) async throws -> Data {
        let (status, out, err) = try await Task.detached {
            try runToEnd(node, [script, "setup", "claude"] + args)
        }.value
        guard status == 0 else {
            throw Failed(
                description: String(decoding: err, as: UTF8.self)
                    .trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return out
    }

    private nonisolated static func runToEnd(_ executable: String, _ args: [String]) throws -> (
        Int32, Data, Data
    ) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try process.run()
        // Small enough output that reading one pipe to the end can't stall
        // the other.
        let stdout = out.fileHandleForReading.readDataToEndOfFile()
        let stderr = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, stdout, stderr)
    }

    private static func tell(_ title: String, _ detail: String, on window: NSWindow?) async {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        _ = await show(alert, on: window)
    }

    private static func show(_ alert: NSAlert, on window: NSWindow?) async -> NSApplication.ModalResponse {
        guard let window else { return alert.runModal() }
        return await withCheckedContinuation { done in
            alert.beginSheetModal(for: window) { done.resume(returning: $0) }
        }
    }
}
