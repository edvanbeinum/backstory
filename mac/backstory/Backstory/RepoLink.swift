import Foundation

/// Turns what the app is asked to open (a `backstory://open?repo=<path>` link, or
/// a folder from the Dock or Open Repo…) into the address the web view loads:
/// `/?repo=<path>`, which the page reads on load.
enum RepoLink {
    /// The address that opens `url`'s repo on `server`, or nil for anything
    /// that isn't a `backstory://open` link with an absolute repo, or a file URL.
    static func address(for url: URL, server: URL) -> URL? {
        guard let repo = repoPath(from: url) else { return nil }
        return address(forRepo: repo, server: server)
    }

    static func repoPath(from url: URL) -> String? {
        if url.isFileURL { return url.standardizedFileURL.path }
        guard url.scheme?.lowercased() == "backstory",
            url.host?.lowercased() == "open",
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let repo = components.queryItems?.first(where: { $0.name == "repo" })?.value,
            repo.hasPrefix("/")
        else { return nil }
        return repo
    }

    static func address(forRepo repo: String, server: URL) -> URL {
        // Encode `+` too: URLComponents leaves it bare in a query, and the
        // page's URLSearchParams reads a bare `+` as a space, so a repo under
        // `c++` would open the wrong path.
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "+&=#")
        let encoded = repo.addingPercentEncoding(withAllowedCharacters: allowed) ?? repo
        var components = URLComponents(url: server, resolvingAgainstBaseURL: false)!
        components.path = "/"
        components.percentEncodedQuery = "repo=\(encoded)"
        return components.url!
    }
}
