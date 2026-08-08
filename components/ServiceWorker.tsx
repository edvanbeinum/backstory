"use client";

import { useEffect } from "react";

/**
 * Installs public/sw.js, whose only job is to show a real page instead of
 * "refused to connect" when the differ server isn't running.
 *
 * Registration has to happen while the server is *up* — a browser can't
 * install a worker it can't fetch. So this runs on every load, and the very
 * first launch after installing differ is the one time the dead-server case
 * still shows the browser's own error.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      // `updateViaCache: "none"` keeps an HTTP-cached sw.js from pinning an
      // old offline page in place after an upgrade.
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => {
        // A missing worker costs nothing but a nicer error screen.
      });
  }, []);

  return null;
}
