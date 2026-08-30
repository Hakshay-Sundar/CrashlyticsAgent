import { execa } from 'execa';

export interface Git {
  topLevel(cwd: string): Promise<string | null>;
  currentBranch(cwd: string): Promise<string>;
  remoteUrl(cwd: string, remote: string): Promise<string | null>;
  checkoutNewBranch(cwd: string, branch: string, base: string): Promise<void>;
  resetHard(cwd: string, ref: string): Promise<void>;
  clean(cwd: string, excludes: string[]): Promise<void>;
  status(cwd: string): Promise<{ path: string }[]>;
  diff(cwd: string): Promise<string>;
  add(cwd: string, paths: string[]): Promise<void>;
  commit(cwd: string, message: string): Promise<string>;
  push(cwd: string, remote: string, branch: string): Promise<void>;
  deleteBranch(cwd: string, branch: string): Promise<void>;
  worktreeAdd(repoDir: string, worktreeDir: string, branch: string, base: string): Promise<void>;
  worktreeRemove(repoDir: string, worktreeDir: string): Promise<void>;
  worktreeList(repoDir: string): Promise<{ path: string; branch: string }[]>;
  revParse(cwd: string, ref: string): Promise<string>;
}

async function g(cwd: string, args: string[]): Promise<string> {
  // execa already strips the trailing newline; don't trim further — porcelain
  // status lines carry a significant leading space in the first status column.
  const { stdout } = await execa('git', args, { cwd });
  return stdout;
}

export const realGit: Git = {
  async topLevel(cwd) {
    try {
      return await g(cwd, ['rev-parse', '--show-toplevel']);
    } catch {
      return null;
    }
  },
  currentBranch: (cwd) => g(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
  async remoteUrl(cwd, remote) {
    try {
      return await g(cwd, ['remote', 'get-url', remote]);
    } catch {
      return null;
    }
  },
  async checkoutNewBranch(cwd, branch, base) {
    await g(cwd, ['checkout', '-B', branch, base]);
  },
  async resetHard(cwd, ref) {
    await g(cwd, ['reset', '--hard', ref]);
  },
  async clean(cwd, excludes) {
    await g(cwd, ['clean', '-fdx', ...excludes.flatMap((e) => ['-e', e])]);
  },
  async status(cwd) {
    const out = await g(cwd, ['status', '--porcelain']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => ({ path: l.slice(3).trim() }));
  },
  diff: (cwd) => g(cwd, ['--no-pager', 'diff']),
  async add(cwd, paths) {
    await g(cwd, ['add', ...paths]);
  },
  async commit(cwd, message) {
    await g(cwd, ['commit', '-m', message]);
    return g(cwd, ['rev-parse', 'HEAD']);
  },
  async push(cwd, remote, branch) {
    await g(cwd, ['push', '-u', remote, branch]);
  },
  async deleteBranch(cwd, branch) {
    try {
      await g(cwd, ['branch', '-D', branch]);
    } catch {
      /* branch absent — fine */
    }
  },
  async worktreeAdd(repoDir, worktreeDir, branch, base) {
    await g(repoDir, ['worktree', 'add', '-B', branch, worktreeDir, base]);
  },
  async worktreeRemove(repoDir, worktreeDir) {
    try {
      await g(repoDir, ['worktree', 'remove', '--force', worktreeDir]);
    } catch {
      /* already gone — fine */
    }
  },
  async worktreeList(repoDir) {
    const out = await g(repoDir, ['worktree', 'list', '--porcelain']);
    return out
      .split('\n\n')
      .filter(Boolean)
      .map((b) => ({
        path: /^worktree (.+)$/m.exec(b)?.[1] ?? '',
        branch: /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] ?? '',
      }))
      .filter((w) => w.path);
  },
  revParse: (cwd, ref) => g(cwd, ['rev-parse', ref]),
};
