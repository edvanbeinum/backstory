import type { MetadataRoute } from "next";

/**
 * The web app manifest is what makes differ installable as a standalone
 * window — Chrome's "Install page as app" and Safari's "Add to Dock" both
 * read it. `display: standalone` is the part that buys the Cmd-Tab presence:
 * the installed window gets its own dock icon and app-switcher entry instead
 * of living in the browser tab pile.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "differ",
    short_name: "differ",
    description:
      "Review your unpushed commits against their PR comments, before you push.",
    start_url: "/",
    display: "standalone",
    background_color: "#0d1117",
    theme_color: "#0d1117",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    // Not declared `maskable`: the icon is a bordered rounded tile, so a
    // launcher cropping it to a circle would cut the border off. Better to
    // let the OS letterbox it than to promise padding that isn't there.
  };
}
