import { execaSync } from 'execa';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface NestedRepo {
  name: string;
  path: string;
  remote: string; // path to a bare repo acting as origin
}

// ponytail: synchronous via execaSync — the tests call makeNestedRepos() and
// read .root without awaiting. Real git, real tmpdirs, offline.
function git(cwd: string, ...args: string[]): void {
  execaSync('git', args, { cwd });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  // -b main keeps the default branch deterministic across git versions / configs
  execaSync('git', ['init', '-b', 'main'], { cwd: dir });
  git(dir, 'config', 'user.email', 'crashfix@test.local');
  git(dir, 'config', 'user.name', 'crashfix test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

function bareRemoteFor(repoDir: string, bareDir: string): void {
  execaSync('git', ['init', '--bare', '-b', 'main', bareDir]);
  git(repoDir, 'remote', 'add', 'origin', bareDir);
  git(repoDir, 'push', '-u', 'origin', 'main');
}

export function makeNestedRepos(): { root: string; repos: NestedRepo[] } {
  // realpathSync: on macOS tmpdir() is a symlink; git reports the resolved path,
  // so tests comparing topLevel(root) === root need root already resolved.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'crashfix-repos-')));
  const root = join(base, 'A');

  initRepo(root);
  writeFileSync(join(root, 'app.txt'), 'original\n');
  writeFileSync(join(root, '.gitignore'), 'B/\nC/\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial commit');

  const repos: NestedRepo[] = [];
  for (const name of ['B', 'C']) {
    const path = join(root, name);
    initRepo(path);
    writeFileSync(join(path, `${name}.txt`), `module ${name}\n`);
    git(path, 'add', '-A');
    git(path, 'commit', '-m', `init ${name}`);
    const remote = join(base, 'remotes', `${name}.git`);
    bareRemoteFor(path, remote);
    repos.push({ name, path, remote });
  }

  return { root, repos };
}

// Seed an obvious null-deref into repo B's history so a scripted fake solver can
// "fix" it (replace `feed!!` with `feed?`) and produce a real diff to commit.
export function seedSource(root: string): string {
  const dir = join(root, 'B', 'app');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'Feature.kt');
  writeFileSync(
    file,
    [
      'package app',
      '',
      'class Feature(private val repo: Repo) {',
      '    fun render(): String {',
      '        val feed = repo.loadFeed()',
      '        return feed!!.items.joinToString()',
      '    }',
      '}',
      '',
    ].join('\n'),
  );
  git(join(root, 'B'), 'add', '-A');
  git(join(root, 'B'), 'commit', '-m', 'add Feature with null-deref');
  return file;
}
