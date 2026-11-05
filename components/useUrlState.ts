"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { STORAGE_KEY, WORKING_REV } from "@/lib/constants";
import { readUrlState, resolveTab, writeUrlState, type Tab } from "@/lib/url";

/**
 * The view in the address bar: the repo, the branch, the change, the tab and
 * the comment, read once the page mounts, written back as they change, and
 * restored by Back and Forward.
 */
export function useUrlState() {
  const [repo, setRepo] = useState("");
  /** A branch to review instead of the worktree's own. Null = the checkout. */
  const [ref, setRef] = useState<string | null>(null);
  const [rev, setRev] = useState<string>(WORKING_REV);
  const [tab, setTab] = useState<Tab>("story");
  /** The focused review thread, outlined in Comments. */
  const [comment, setComment] = useState<string | null>(null);
  /** `?setup=1`: the inbox shows the setup checklist whatever else it has */
  const [setup, setSetup] = useState(false);
  const [ready, setReady] = useState(false);

  // A bare `/` is the inbox. The last repo's key is still written, so the
  // inbox can mark where you were, but it never skips past the inbox.
  useEffect(() => {
    const fromUrl = readUrlState();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the URL is only readable after mount
    setRepo(fromUrl.repo ?? "");
    setRef(fromUrl.ref ?? null);
    setSetup(Boolean(fromUrl.setup));
    if (fromUrl.rev) setRev(fromUrl.rev);
    setTab(resolveTab(fromUrl));
    setComment(fromUrl.comment);
    if (fromUrl.repo) window.localStorage.setItem(STORAGE_KEY, fromUrl.repo);
    setReady(true);
  }, []);

  // Entering or leaving a workspace is a real navigation and gets a history
  // entry; moving between comments and commits inside one replaces, so Back
  // doesn't have to walk back through every keystroke.
  const wasInWorkspace = useRef(false);
  useEffect(() => {
    if (!ready) return;
    const inWorkspace = Boolean(repo);
    writeUrlState(
      {
        repo: repo || null,
        ref,
        rev,
        comment,
        tab: inWorkspace ? tab : undefined,
        setup: setup && !inWorkspace,
      },
      { push: inWorkspace !== wasInWorkspace.current },
    );
    wasInWorkspace.current = inWorkspace;
  }, [ready, repo, ref, rev, comment, tab, setup]);

  useEffect(() => {
    const onPopState = () => {
      const fromUrl = readUrlState();
      setRepo(fromUrl.repo ?? "");
      setRef(fromUrl.ref ?? null);
      setRev(fromUrl.rev ?? WORKING_REV);
      setComment(fromUrl.comment);
      setTab(resolveTab(fromUrl));
      setSetup(Boolean(fromUrl.setup));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  /**
   * Opens a checkout on Story. The ref is always set, never left alone:
   * a new path with a stale branch still applied would review something that
   * isn't there.
   */
  const open = useCallback((path: string, branch: string | null) => {
    window.localStorage.setItem(STORAGE_KEY, path);
    setRef(branch);
    setRepo(path);
    setSetup(false);
    setTab("story");
  }, []);

  /** Back to the home screen. Clearing the repo is what the inbox *is*. */
  const toInbox = useCallback(() => {
    setRepo("");
    setRef(null);
    setComment(null);
    setRev(WORKING_REV);
    setTab("story");
  }, []);

  return {
    repo,
    ref,
    rev,
    tab,
    comment,
    setup,
    ready,
    setRev,
    setTab,
    setComment,
    setSetup,
    open,
    toInbox,
  };
}
