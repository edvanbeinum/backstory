import { reading, transaction } from "./store";

/**
 * The tip each branch had when you last opened it, so the inbox can say which
 * branches have changed since. Keyed by the repo's common git dir, so every
 * worktree of a repo shares one mark per branch and two repos with a branch
 * of the same name don't.
 */

export interface Looked {
  tip: string;
  at: number;
}

export function markLooked(
  commonDir: string,
  branch: string,
  tip: string,
  at = Date.now(),
): void {
  transaction((database) =>
    database
      .prepare(
        "INSERT OR REPLACE INTO looked (common_dir, branch, tip, at) VALUES (?, ?, ?, ?)",
      )
      .run(commonDir, branch, tip, at),
  );
}

export function lookedTips(commonDir: string): Map<string, Looked> {
  return reading(new Map(), (database) => {
    const rows = database
      .prepare("SELECT branch, tip, at FROM looked WHERE common_dir = ?")
      .all(commonDir) as unknown as Array<{ branch: string } & Looked>;
    return new Map(
      rows.map((row) => [row.branch, { tip: row.tip, at: row.at }]),
    );
  });
}
