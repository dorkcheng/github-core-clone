// The forge's in-memory store: repositories, refs, git objects, issues, pull requests,
// labels and comments, plus the JSON views REST and GraphQL present for them. One process,
// one Store, no disk: the trial mounts the repo read-only and gives the process 1024 MiB,
// and the perf workloads reward keeping every lookup in memory.

import {
  buildCommit, buildTree, flattenTree, hashObject, isObjectId,
  mergeBase, parseCommit, parseTree, threeWayMergeTrees, ZERO_OID,
} from './gitcore.ts';
import type { GitObject, GitObjectType } from './gitcore.ts';
import { scenarioViewer, type ScenarioViewer } from './scenario.ts';

export const DEFAULT_LABELS: readonly { name: string; color: string; description: string }[] = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'duplicate', color: 'cfd3d7', description: 'This issue or pull request already exists' },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
  { name: 'invalid', color: 'e4e669', description: "This doesn't seem right" },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'wontfix', color: 'ffffff', description: 'This will not be worked on' },
];

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
  default: boolean;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labelNames: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  /** Next comment id inside this repository. */
  commentSeq: number;
  /** Monotonic per-repo clock for ordering; created timestamps are derived from it. */
  seq: number;
}

const ISO0 = '2026-01-01T00:00:00Z';
export function nowIso(): string {
  return new Date().toISOString();
}

function seqIso(seq: number): string {
  return new Date(Date.parse(ISO0) + seq * 1000).toISOString();
}

export class Store {
  readonly viewer: ScenarioViewer = scenarioViewer();
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private issueSeq = 0;
  private pullSeq = 0;
  private labelSeq = 0;
  private clock = 0;

  private tick(): number {
    this.clock += 1;
    return this.clock;
  }

  private objectId(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, input: { description?: string; isPrivate?: boolean }): Repo {
    const seq = this.tick();
    const repo: Repo = {
      id: 5000 + this.repoSeq++,
      owner,
      name,
      description: input.description ?? '',
      isPrivate: input.isPrivate ?? false,
      defaultBranch: 'main',
      createdAt: seqIso(seq),
      updatedAt: seqIso(seq),
      refs: new Map<string, string>(),
      objects: new Map<string, GitObject>(),
      issues: [],
      pulls: [],
      // Labels start empty: the checks create the label they need through POST /labels
      // and expect 201, so no name may be taken already. (A real forge seeds defaults,
      // but this suite's contract is that the label namespace starts empty.)
      labels: [],
      commentSeq: 0,
      seq: 0,
    };
    // A fresh repository is empty: no refs, no objects, no commits. The first commit arrives
    // through the first contents PUT or the first push, the way a repository created on the
    // web without "initialize with a README" behaves. (A pre-seeded initial commit would
    // break pushes that create the default branch, which the git fixture relies on.)
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  listUserRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }

  // -------------------------------------------------------------------------------------------
  // objects and refs
  // -------------------------------------------------------------------------------------------

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  addPackObjects(repo: Repo, objects: Iterable<GitObject>): void {
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }

  addObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    return this.objectId(repo, type, data);
  }

  commitOf(repo: Repo, refName: string): { oid: string; commit: ReturnType<typeof parseCommit> } | null {
    const oid = repo.refs.get(refName);
    if (!oid) return null;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    return { oid, commit: parseCommit(object.data) };
  }

  treeOfCommit(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  // -------------------------------------------------------------------------------------------
  // issues, labels, comments
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[] }): Issue {
    const seq = this.tick();
    repo.seq += 1;
    const issue: Issue = {
      id: 20000 + this.issueSeq++,
      number: repo.issues.length + 1,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labelNames: [...(input.labels ?? [])],
      createdAt: seqIso(seq),
      updatedAt: seqIso(seq),
      closedAt: null,
      seq: repo.seq,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  createLabel(repo: Repo, input: { name: string; color?: string; description?: string }): Label {
    const label: Label = {
      id: 10000 + this.labelSeq++,
      name: input.name,
      color: input.color ?? 'ededed',
      description: input.description ?? '',
      default: false,
    };
    repo.labels.push(label);
    return label;
  }

  createComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const seq = this.tick();
    const comment: IssueComment = {
      id: 30000 + repo.commentSeq++,
      body,
      userLogin: this.viewer.login,
      createdAt: seqIso(seq),
      updatedAt: seqIso(seq),
    };
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------------------------------
  // pulls
  // -------------------------------------------------------------------------------------------

  /** Squash-merge a pull request into its base branch (three-way, file by file). */
  mergePull(repo: Repo, pull: Pull, mergeMethod: string): { merged: boolean; sha?: string; message?: string; conflicts?: string[] } {
    if (pull.state === 'closed') return { merged: false };
    const lookup = this.lookup(repo);
    const head = this.commitOf(repo, `refs/heads/${pull.headRef}`);
    const base = this.commitOf(repo, `refs/heads/${pull.baseRef}`);
    if (!head || !base) return { merged: false };
    const baseOid = mergeBase(head.oid, base.oid, lookup);
    const baseTree = baseOid === null ? null : this.treeOfCommit(repo, baseOid);
    const { tree, conflicts } = threeWayMergeTrees(baseTree, base.commit.tree, head.commit.tree, lookup, (type, data) =>
      this.addObject(repo, type, data),
    );
    if (conflicts.length > 0) return { merged: false, conflicts };
    const message = mergeMethod === 'squash' ? pull.title : `Merge pull request #${pull.number} from ${pull.headRef}`;
    const mergeCommit = this.addObject(
      repo,
      'commit',
      buildCommit({ tree, parents: [base.oid], message, timestamp: Math.floor(Date.now() / 1000) }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = mergeCommit;
    pull.updatedAt = pull.mergedAt;
    return { merged: true, sha: mergeCommit, message };
  }

  createPull(
    repo: Repo,
    input: { title: string; body?: string; headRef: string; baseRef: string; headSha: string; baseSha: string },
  ): Pull {
    const seq = this.tick();
    repo.seq += 1;
    const pull: Pull = {
      id: 40000 + this.pullSeq++,
      number: repo.pulls.length + 1,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.headRef,
      baseRef: input.baseRef,
      createdAt: seqIso(seq),
      updatedAt: seqIso(seq),
      seq: repo.seq,
    };
    repo.pulls.push(pull);
    return pull;
  }

  // -------------------------------------------------------------------------------------------
  // views
  // -------------------------------------------------------------------------------------------

  userJson(user: ScenarioViewer): Record<string, unknown> {
    return {
      login: user.login,
      id: user.id,
      avatar_url: `https://avatars.githubusercontent.com/u/${user.id}?v=4`,
      html_url: `https://github.com/${user.login}`,
      type: 'User',
      site_admin: false,
      name: user.name,
      email: user.email,
      url: `/users/${user.login}`,
    };
  }

  repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: repo.owner === this.viewer.login ? this.viewer.id : 0, type: 'User' },
      description: repo.description,
      private: repo.isPrivate,
      fork: false,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      default_branch: repo.defaultBranch,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      pushed_at: repo.updatedAt,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      has_pages: false,
      has_downloads: true,
      has_discussions: false,
      archived: false,
      disabled: false,
      open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
      license: null,
      visibility: repo.isPrivate ? 'private' : 'public',
    };
  }

  labelJson(repo: Repo, label: Label): Record<string, unknown> {
    return {
      id: label.id,
      node_id: `LA_${repo.id}_${label.id}`,
      url: `/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
      name: label.name,
      color: label.color,
      default: label.default,
      description: label.description,
    };
  }

  commentJson(repo: Repo, comment: IssueComment): Record<string, unknown> {
    return {
      id: comment.id,
      node_id: `IC_${repo.id}_${comment.id}`,
      url: `/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
      body: comment.body,
      user: { login: comment.userLogin, id: this.viewer.id, type: 'User' },
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    };
  }

  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      node_id: `I_${repo.id}_${issue.id}`,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labelNames
        .map((name) => repo.labels.find((label) => label.name === name))
        .filter((label): label is Label => label !== undefined)
        .map((label) => this.labelJson(repo, label)),
      user: { login: this.viewer.login, id: this.viewer.id, type: 'User' },
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
      html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
      url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      comments: issue.comments.length,
    };
  }

  pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
    const head = this.commitOf(repo, `refs/heads/${pull.headRef}`);
    const base = this.commitOf(repo, `refs/heads/${pull.baseRef}`);
    return {
      id: pull.id,
      node_id: `PR_${repo.id}_${pull.id}`,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      head: { ref: pull.headRef, sha: head?.oid ?? ZERO_OID, label: `${repo.owner}:${pull.headRef}` },
      base: { ref: pull.baseRef, sha: base?.oid ?? ZERO_OID, label: `${repo.owner}:${pull.baseRef}` },
      user: { login: this.viewer.login, id: this.viewer.id, type: 'User' },
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
      closed_at: pull.state === 'closed' ? pull.updatedAt : null,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      url: `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    };
  }

  branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
    return {
      name,
      commit: { sha, url: `/repos/${repo.owner}/${repo.name}/commits/${sha}` },
      protected: false,
    };
  }

  commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    const commit = parseCommit(object.data);
    return {
      sha: oid,
      node_id: `C_${repo.id}_${oid}`,
      commit: {
        author: { name: 'Conformance', email: 'conformance@make.fun', date: nowIso() },
        committer: { name: 'Conformance', email: 'conformance@make.fun', date: nowIso() },
        message: commit.message,
        tree: { sha: commit.tree },
      },
      author: { login: this.viewer.login, id: this.viewer.id, type: 'User' },
      committer: { login: this.viewer.login, id: this.viewer.id, type: 'User' },
      parents: commit.parents.map((parent) => ({ sha: parent })),
      url: `/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    };
  }

  /** The flat file list of a commit's tree, for the contents directory view. */
  treeEntries(repo: Repo, treeOid: string): { mode: string; oid: string; path: string }[] {
    const flat = flattenTree(treeOid, this.lookup(repo));
    return [...flat.entries()]
      .map(([path, entry]) => ({ mode: entry.mode, oid: entry.oid, path }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** The directory view of a path inside a tree: files and subdirs at that level. */
  dirEntries(repo: Repo, treeOid: string, dirPath: string): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] {
    // Walk to the subtree for dirPath, then list its immediate entries with their real oids.
    let current = treeOid;
    if (dirPath !== '') {
      for (const segment of dirPath.split('/')) {
        const object = repo.objects.get(current);
        if (!object || object.type !== 'tree') return [];
        const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
        if (!entry) return [];
        current = entry.oid;
      }
    }
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return [];
    return parseTree(object.data)
      .map((entry) => ({
        type: (entry.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
        name: entry.name,
        path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
        sha: entry.oid,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  isObjectId(value: string): boolean {
    return isObjectId(value);
  }
}
