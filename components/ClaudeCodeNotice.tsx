"use client";

import type { ProviderGap } from "@/lib/ai/provider";
import { Button, CopyButton } from "./ui";

export const CLAUDE_CODE_INSTALL =
  "https://code.claude.com/docs/en/setup#install-claude-code";

/**
 * What to do when Claude Code isn't installed or is logged out, with the
 * button that fixes it. Logging in belongs to Claude Code, so Backstory only
 * gives the command. It names `claude auth login`, not `claude`: a signed-out
 * `claude` opens looking ready and asks to log in only at the first prompt.
 */
export function ClaudeCodeNotice({
  reason,
  needs,
  children,
}: {
  reason: ProviderGap;
  /** What can't run without it, leading the message: "Flows need" */
  needs?: string;
  /** More actions, after the fix's button */
  children?: React.ReactNode;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>
        {needs && <>{needs} Claude Code. </>}
        {reason === "no-claude" ? (
          <>Backstory can&apos;t find Claude Code on this Mac.</>
        ) : (
          <>
            Claude Code is signed out. Run{" "}
            <code className="mono">claude auth login</code> in Terminal.
          </>
        )}
      </span>
      {reason === "no-claude" ? (
        <Button size="sm" href={CLAUDE_CODE_INSTALL}>
          Get Claude Code
        </Button>
      ) : (
        <CopyButton value="claude auth login" label="Copy: claude auth login" />
      )}
      {children}
    </span>
  );
}
