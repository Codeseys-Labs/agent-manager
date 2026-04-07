import git from "isomorphic-git";
import * as fs from "node:fs";
import { join } from "node:path";

const DEFAULT_AUTHOR = { name: "agent-manager", email: "am@localhost" };

const GITIGNORE_ENTRIES = [
  "config.local.toml",
  ".agent-manager/state.toml",
  ".agent-manager/key.txt",
];

export async function initRepo(dir: string): Promise<void> {
  await git.init({ fs, dir, defaultBranch: "main" });
  await fs.promises.mkdir(join(dir, ".agent-manager"), { recursive: true });
  await fs.promises.writeFile(
    join(dir, ".gitignore"),
    GITIGNORE_ENTRIES.join("\n") + "\n",
  );
  await git.add({ fs, dir, filepath: ".gitignore" });
  await git.commit({
    fs,
    dir,
    message: "init: agent-manager repository",
    author: DEFAULT_AUTHOR,
  });
}

export async function commitAll(
  dir: string,
  message: string,
): Promise<string> {
  const matrix = await git.statusMatrix({ fs, dir });

  // Stage everything first — git.add forces a content hash check that
  // bypasses isomorphic-git's stat-based index cache.
  for (const [filepath, _head, workdir, _stage] of matrix) {
    if (workdir === 0) {
      await git.remove({ fs, dir, filepath });
    } else {
      await git.add({ fs, dir, filepath });
    }
  }

  // Re-read the matrix after staging to detect real changes
  const staged = await git.statusMatrix({ fs, dir });
  const hasChanges = staged.some(
    ([_f, head, _workdir, stage]) => !(head === 1 && stage === 1),
  );

  if (!hasChanges) {
    throw new Error("Nothing to commit");
  }

  return git.commit({ fs, dir, message, author: DEFAULT_AUTHOR });
}

export async function push(
  dir: string,
  remote = "origin",
  branch?: string,
): Promise<void> {
  const ref = branch ?? (await git.currentBranch({ fs, dir })) ?? "main";
  await git.push({
    fs,
    http: (await import("isomorphic-git/http/node/index.cjs")).default,
    dir,
    remote,
    ref,
  });
}

export async function pull(
  dir: string,
  remote = "origin",
  branch?: string,
): Promise<void> {
  const ref = branch ?? (await git.currentBranch({ fs, dir })) ?? "main";
  await git.pull({
    fs,
    http: (await import("isomorphic-git/http/node/index.cjs")).default,
    dir,
    remote,
    ref,
    author: DEFAULT_AUTHOR,
  });
}

export interface LogEntry {
  oid: string;
  message: string;
  author: { name: string; email: string; timestamp: number };
}

export async function log(dir: string, count?: number): Promise<LogEntry[]> {
  const commits = await git.log({ fs, dir, depth: count });
  return commits.map((c) => ({
    oid: c.oid,
    message: c.commit.message.trim(),
    author: {
      name: c.commit.author.name,
      email: c.commit.author.email,
      timestamp: c.commit.author.timestamp,
    },
  }));
}

export async function revertHead(dir: string): Promise<string> {
  const commits = await git.log({ fs, dir, depth: 2 });
  if (commits.length < 2) {
    throw new Error("Cannot revert: no parent commit");
  }

  const parentOid = commits[1].oid;
  const headMessage = commits[0].commit.message.trim();

  // Read every file from the parent tree and write it to the workdir,
  // then stage the result. We use TREE to walk the parent and HEAD to diff.
  // Strategy: checkout the parent tree contents into workdir.
  const parentTree = commits[1].commit.tree;
  const headTree = commits[0].commit.tree;

  // Get files in parent commit
  const parentFiles = await listTreeFiles(dir, parentOid);
  // Get files in HEAD commit
  const headFiles = await listTreeFiles(dir, commits[0].oid);

  // Write all parent files to workdir
  for (const filepath of parentFiles) {
    const { blob } = await git.readBlob({
      fs,
      dir,
      oid: parentOid,
      filepath,
    });
    const fullPath = join(dir, filepath);
    await fs.promises.mkdir(join(fullPath, ".."), { recursive: true });
    await fs.promises.writeFile(fullPath, Buffer.from(blob));
    await git.add({ fs, dir, filepath });
  }

  // Remove files that existed in HEAD but not in parent
  for (const filepath of headFiles) {
    if (!parentFiles.includes(filepath)) {
      const fullPath = join(dir, filepath);
      try {
        await fs.promises.unlink(fullPath);
      } catch {
        // File may already be gone
      }
      await git.remove({ fs, dir, filepath });
    }
  }

  return git.commit({
    fs,
    dir,
    message: `revert: ${headMessage}`,
    author: DEFAULT_AUTHOR,
  });
}

async function listTreeFiles(
  dir: string,
  oid: string,
): Promise<string[]> {
  const files: string[] = [];
  await git.walk({
    fs,
    dir,
    trees: [git.TREE({ ref: oid })],
    map: async (filepath, [entry]) => {
      if (!entry) return;
      const type = await entry.type();
      if (type === "blob" && filepath !== ".") {
        files.push(filepath);
      }
      return filepath;
    },
  });
  return files;
}

export interface StatusResult {
  branch: string;
  clean: boolean;
  dirty: string[];
  remotes: Array<{ remote: string; url: string }>;
}

export async function getStatus(dir: string): Promise<StatusResult> {
  const branch =
    (await git.currentBranch({ fs, dir })) ?? "HEAD (detached)";
  const matrix = await git.statusMatrix({ fs, dir });
  const dirty: string[] = [];

  for (const [filepath, head, workdir, stage] of matrix) {
    if (!(head === 1 && workdir === 1 && stage === 1)) {
      dirty.push(filepath);
    }
  }

  const remotes = await git.listRemotes({ fs, dir });

  return {
    branch,
    clean: dirty.length === 0,
    dirty,
    remotes,
  };
}

export async function addRemote(
  dir: string,
  url: string,
  remote = "origin",
): Promise<void> {
  await git.addRemote({ fs, dir, remote, url });
}
