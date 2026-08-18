import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `chmod` refusals are the subject here, and they cannot be provoked for real
 * without either root or a second account: the paths a test user cannot narrow
 * are paths like `/`, which a suite running as root would actually modify.
 *
 * The module is mocked in a file of its own so the rest of the repository suite
 * keeps running against the real filesystem.
 */
const unchmoddable = new Set<string>();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    chmodSync: (target: Parameters<typeof actual.chmodSync>[0], mode: Parameters<typeof actual.chmodSync>[1]) => {
      if (unchmoddable.has(String(target))) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return actual.chmodSync(target, mode);
    },
  };
});

const { CollectorRepository } = await import("./repository.js");

const cleanups: Array<() => void> = [];
afterEach(() => {
  unchmoddable.clear();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function open(databasePath: string): InstanceType<typeof CollectorRepository> {
  const repo = new CollectorRepository(databasePath);
  cleanups.push(() => repo.close());
  return repo;
}

function directory(): string {
  const created = mkdtempSync(path.join(tmpdir(), "collector-perms-"));
  cleanups.push(() => rmSync(created, { recursive: true, force: true }));
  return created;
}

describe("CollectorRepository under a filesystem that refuses chmod", () => {
  /**
   * A directory owned by someone else — the shared temp root, a mount — cannot be
   * narrowed by this process. The database file inside it still can be, and that
   * mode is what withholds the text, so refusing to start would cost the operator
   * the whole collector for no gain in privacy.
   */
  it("still opens when the containing directory cannot be narrowed", () => {
    const root = directory();
    unchmoddable.add(root);

    const repo = open(path.join(root, "collector.sqlite"));

    expect(repo.filePermissionsEnforced).toBe(true);
  });

  /** Where the file mode itself will not hold, the archive has to admit it. */
  it("reports the database as unprotected when its own mode cannot be set", () => {
    const root = directory();
    const databasePath = path.join(root, "collector.sqlite");
    unchmoddable.add(databasePath);

    const repo = open(databasePath);

    expect(repo.filePermissionsEnforced).toBe(false);
  });
});
