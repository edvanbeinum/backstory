# Homebrew formula skeleton for differ.
#
# To make this installable you need a tap: create a GitHub repo named
# `homebrew-differ` under your account, put this file at Formula/differ.rb,
# fill in `url` and `sha256` for a tagged release tarball, and then:
#
#   brew tap edvanbeinum/differ
#   brew install differ
#   brew services start differ    # optional: plain `differ` installs its own
#                                 # login agent otherwise; with this, it defers
#
# The release tarball this expects is the standalone build plus the launcher:
#   npm ci && npm run build
#   tar -czf differ-<version>.tar.gz -C .next standalone -C ../.. bin/differ.mjs
#
class Differ < Formula
  desc "Local pre-push PR review: unpushed commits beside their review comments"
  homepage "https://github.com/edvanbeinum/differ"
  url "https://github.com/edvanbeinum/differ/releases/download/v0.1.0/differ-0.1.0.tar.gz"
  sha256 "REPLACE_WITH_RELEASE_TARBALL_SHA256"
  license "MIT"

  depends_on "node"

  def install
    # Lay out exactly what bin/differ.mjs's findServer() probes for:
    #   <root>/standalone/server.js  and  <root>/bin/differ.mjs
    libexec.install "standalone"
    libexec.install "bin"
    (bin/"differ").write_env_script "#{Formula["node"].opt_bin}/node",
                                    libexec/"bin/differ.mjs",
                                    {}
  end

  # `brew services start differ` runs the server under launchd so the
  # installed app window always has a live backend to Cmd-Tab into.
  service do
    run [Formula["node"].opt_bin/"node", opt_libexec/"standalone/server.js"]
    keep_alive true
    environment_variables(
      PORT:     "4460",
      HOSTNAME: "127.0.0.1",
      # launchd does not inherit a login shell's PATH; without this the
      # service can't find `gh` (or a Homebrew git) and PR comments silently
      # degrade. The server also self-heals PATH (lib/exec.ts), so this is
      # belt and braces.
      PATH:     "#{HOMEBREW_PREFIX}/bin:/usr/bin:/bin",
    )
    log_path var/"log/differ.log"
    error_log_path var/"log/differ.log"
  end

  test do
    port = free_port
    pid = spawn({ "PORT" => port.to_s, "HOSTNAME" => "127.0.0.1" },
                Formula["node"].opt_bin/"node", opt_libexec/"standalone/server.js")
    sleep 3
    assert_match "differ", shell_output("curl -s http://127.0.0.1:#{port}/api/health")
  ensure
    Process.kill("TERM", pid)
  end
end
