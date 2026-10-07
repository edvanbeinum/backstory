/**
 * Exits differ's server once the Mac app that started it is gone. The app
 * stops the server when it quits, but nothing in the app runs when it is
 * killed outright, and the orphaned server would hold the port. An orphan is
 * re-parented to launchd (pid 1), which is also what the parent already is
 * when the app died before this ran.
 * The app preloads this with `node --require`; the server knows nothing of it.
 */
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent || process.ppid === 1) process.exit(0);
}, 1000).unref();
