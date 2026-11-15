// REST v3: /api/v3. One handler per resource family, all reading the same Store the git,
// GraphQL and MCP surfaces read, so a pull request created through GraphQL shows up here
// and vice versa. Every reply is JSON with a message on errors; pagination uses Link
// rel="next" with same-origin absolute URLs built from the request Host.

import {
  ancestorsOf, buildCommit, diffTrees, flattenTree, isObjectId, mergeBase,
  parseCommit, setPathInTree,
} from './gitcore.ts';
import type { HttpResponse } from './git.ts';
import { jsonResponse } from './git.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

export interface RestRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  host: string;
  body: Buffer;
  json: unknown;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notFound(message = 'Not Found'): HttpResponse {
  return jsonResponse(404, { message });
}

function unprocessable(message: string): HttpResponse {
  return jsonResponse(422, { message });
}

function badRequest(message: string): HttpResponse {
  return jsonResponse(400, { message });
}

function parsePagination(query: URLSearchParams): { perPage: number; page: number } {
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(rawPerPage) && rawPerPage > 0 ? Math.min(rawPerPage, 100) : 30;
  const rawPage = Number.parseInt(query.get('page') ?? '', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  return { perPage, page };
}

function linkHeader(host: string, pathname: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  const build = (targetPage: number): string => {
    const next = new URLSearchParams(query);
    next.set('per_page', String(perPage));
    next.set('page', String(targetPage));
    return `http://${host}${pathname}?${next.toString()}`;
  };
  if (page < totalPages) parts.push(`<${build(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${build(page - 1)}>; rel="prev"`);
  if (totalPages > 1) {
    parts.push(`<${build(1)}>; rel="first"`);
    parts.push(`<${build(totalPages)}>; rel="last"`);
  }
  return parts.length ? parts.join(', ') : null;
}

function paginate<T>(items: readonly T[], query: URLSearchParams, host: string, pathname: string): { page: T[]; link: string | null } {
  const { perPage, page } = parsePagination(query);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  return { page: pageItems, link: linkHeader(host, pathname, query, page, perPage, items.length) };
}

function withLink(response: HttpResponse, link: string | null): HttpResponse {
  if (!link) return response;
  return { ...response, headers: { ...response.headers, link } };
}

function jsonList(items: unknown[], query: URLSearchParams, host: string, pathname: string): HttpResponse {
  const { page, link } = paginate(items, query, host, pathname);
  return withLink(jsonResponse(200, page), link);
}

/** The repository at /repos/{owner}/{name}, or a 404 response. */
function repoOr404(store: Store, owner: string, name: string): Repo | HttpResponse {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  return repo;
}

function issueOr404(repo: Repo, number: number): Issue | HttpResponse {
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (!issue) return notFound('Not Found');
  return issue;
}

function pullOr404(repo: Repo, number: number): Pull | HttpResponse {
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (!pull) return notFound('Not Found');
  return pull;
}

export function handleRest(store: Store, request: RestRequest): HttpResponse | null {
  const { method, pathname } = request;
  const segments = pathname.split('/').filter((segment) => segment !== '');
  // /api/v3/...
  if (segments[0] !== 'api' || segments[1] !== 'v3') return null;
  const rest = segments.slice(2);

  // Root and meta.
  if (rest.length === 0) {
    if (method !== 'GET') return jsonResponse(405, { message: 'Method Not Allowed' });
    const response = jsonResponse(200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://api.github.com/hub',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}{&page,per_page,sort,order}',
      notifications_url: '/api/v3/notifications{?since,all,participating}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_url: '/api/v3/orgs/{org}',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page,sort,order}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
    });
    response.headers['x-oauth-scopes'] = 'repo, read:org';
    return response;
  }
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return jsonResponse(405, { message: 'Method Not Allowed' });
    return jsonResponse(200, { verifiable_password_authentication: true, installed_version: '1.0.0' });
  }

  // /user and /user/repos
  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return jsonResponse(405, { message: 'Method Not Allowed' });
    return jsonResponse(200, store.userJson(store.viewer));
  }
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const body = request.json;
      if (!isJsonObject(body)) return badRequest('request body must be a JSON object');
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return unprocessable('name is required');
      if (store.getRepo(store.viewer.login, name)) {
        return unprocessable(`Repository ${store.viewer.login}/${name} already exists`);
      }
      const repo = store.createRepo(store.viewer.login, name, {
        description: typeof body.description === 'string' ? body.description : undefined,
        isPrivate: typeof body.private === 'boolean' ? body.private : undefined,
      });
      return jsonResponse(201, store.repoJson(repo));
    }
    if (method === 'GET') {
      const repos = store.listUserRepos(store.viewer.login).sort((a, b) => a.id - b.id);
      return jsonList(repos.map((repo) => store.repoJson(repo)), request.query, request.host, request.pathname);
    }
    return jsonResponse(405, { message: 'Method Not Allowed' });
  }

  // /repos/{owner}/{name}/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const repo = repoOr404(store, owner, name);
    if ('status' in repo) return repo;
    const tail = rest.slice(3);

    // The repository itself.
    if (tail.length === 0) {
      if (method === 'GET') return jsonResponse(200, store.repoJson(repo));
      if (method === 'PATCH') {
        const body = request.json;
        if (!isJsonObject(body)) return badRequest('request body must be a JSON object');
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        repo.updatedAt = new Date().toISOString();
        return jsonResponse(200, store.repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        return { status: 204, headers: {}, body: '' };
      }
      return jsonResponse(405, { message: 'Method Not Allowed' });
    }

    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => store.branchJson(repo, branch, repo.refs.get(`refs/heads/${branch}`) as string));
        return jsonResponse(200, branches);
      }
      if (tail.length === 2 && method === 'GET') {
        const branch = tail[1] as string;
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return notFound('Not Found');
        return jsonResponse(200, store.branchJson(repo, branch, sha));
      }
      return jsonResponse(405, { message: 'Method Not Allowed' });
    }

    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'POST') {
        const body = request.json;
        if (!isJsonObject(body)) return badRequest('request body must be a JSON object');
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/heads/') || !isObjectId(sha)) {
          return unprocessable('ref must be refs/heads/<branch> and sha must be a commit object id');
        }
        if (repo.refs.has(ref)) return unprocessable(`Reference ${ref} already exists`);
        if (!repo.objects.has(sha)) return unprocessable(`Object ${sha} does not exist`);
        repo.refs.set(ref, sha);
        return jsonResponse(201, { ref, object: { sha } });
      }
      if (tail.length === 4 && tail[2] === 'heads' && method === 'GET') {
        const branch = tail[3] as string;
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return notFound('Not Found');
        return jsonResponse(200, { ref: `refs/heads/${branch}`, object: { sha } });
      }
      return jsonResponse(405, { message: 'Method Not Allowed' });
    }

    if (tail[0] === 'commits') {
      if (method !== 'GET') return jsonResponse(405, { message: 'Method Not Allowed' });
      const shaParam = request.query.get('sha');
      let tip: string | undefined;
      if (shaParam === null) {
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      } else if (repo.refs.has(`refs/heads/${shaParam}`)) {
        tip = repo.refs.get(`refs/heads/${shaParam}`);
      } else if (isObjectId(shaParam)) {
        tip = shaParam;
      }
      if (!tip) return notFound('Not Found');
      const lookup = store.lookup(repo);
      const commits = ancestorsOf(tip, lookup)
        .map((oid) => store.commitJson(repo, oid))
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      return jsonResponse(200, commits);
    }

    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      return handleContents(store, repo, path, request);
    }

    if (tail[0] === 'issues') {
      return handleIssues(store, repo, tail.slice(1), request);
    }

    if (tail[0] === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        const body = request.json;
        if (!isJsonObject(body)) return badRequest('request body must be a JSON object');
        const labelName = typeof body.name === 'string' ? body.name : '';
        if (labelName === '') return unprocessable('name is required');
        if (repo.labels.some((label) => label.name === labelName)) {
          return unprocessable(`Label ${labelName} already exists`);
        }
        const label = store.createLabel(repo, {
          name: labelName,
          color: typeof body.color === 'string' ? body.color : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
        });
        return jsonResponse(201, store.labelJson(repo, label));
      }
      if (method === 'GET' && tail.length === 1) {
        return jsonResponse(200, repo.labels.map((label) => store.labelJson(repo, label)));
      }
      return jsonResponse(405, { message: 'Method Not Allowed' });
    }

    if (tail[0] === 'pulls') {
      return handlePulls(store, repo, tail.slice(1), request);
    }
  }

  return jsonResponse(404, { message: 'Not Found' });
}

function handleContents(store: Store, repo: Repo, path: string, request: RestRequest): HttpResponse {
  const { method } = request;
  const lookup = store.lookup(repo);

  if (method === 'GET') {
    // ?ref= names a branch (or a commit sha); without it, the default branch.
    const refParam = request.query.get('ref');
    let head: { oid: string; commit: ReturnType<typeof parseCommit> } | null;
    if (refParam === null) {
      head = store.commitOf(repo, `refs/heads/${repo.defaultBranch}`);
    } else if (repo.refs.has(`refs/heads/${refParam}`)) {
      head = store.commitOf(repo, `refs/heads/${refParam}`);
    } else if (/^[0-9a-f]{40}$/.test(refParam)) {
      const object = repo.objects.get(refParam);
      head = object && object.type === 'commit' ? { oid: refParam, commit: parseCommit(object.data) } : null;
    } else {
      head = null;
    }
    if (!head) return notFound('Not Found');
    const flat = flattenTree(head.commit.tree, lookup);
    const entry = flat.get(path);
    if (entry) {
      const object = repo.objects.get(entry.oid);
      if (!object || object.type !== 'blob') return notFound('Not Found');
      return jsonResponse(200, {
        type: 'file',
        encoding: 'base64',
        size: object.data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: object.data.toString('base64'),
        sha: entry.oid,
      });
    }
    // A directory: list its immediate entries.
    const entries = store.dirEntries(repo, head.commit.tree, path);
    if (entries.length === 0) return notFound('Not Found');
    return jsonResponse(200, entries.map((item) => ({ type: item.type, name: item.name, path: item.path, sha: item.sha })));
  }

  if (method === 'PUT') {
    const body = request.json;
    if (!isJsonObject(body)) return badRequest('request body must be a JSON object');
    const message = typeof body.message === 'string' ? body.message : '';
    const content = typeof body.content === 'string' ? body.content : '';
    if (message === '' || content === '') return unprocessable('message and content are required');
    let contentBytes: Buffer;
    try {
      contentBytes = Buffer.from(content, 'base64');
    } catch {
      return unprocessable('content is not valid base64');
    }
    // Resolve the branch: an unknown branch is created from the default branch tip.
    let branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    let tip = repo.refs.get(`refs/heads/${branch}`);
    let head = tip === undefined ? null : store.commitOf(repo, `refs/heads/${branch}`);
    if (head === null) {
      // No tip on the branch: if the default branch has a tip, start the branch there;
      // if the repository is still empty, this PUT is the root commit.
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined && branch !== repo.defaultBranch) {
        repo.refs.set(`refs/heads/${branch}`, defaultTip);
        head = store.commitOf(repo, `refs/heads/${branch}`);
      }
    }
    const baseTree = head === null ? null : head.commit.tree;
    const flat = baseTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(baseTree, lookup);
    const existing = flat.get(path);
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (existing) {
      if (givenSha === undefined) return unprocessable('sha is required to update an existing file');
      if (givenSha !== existing.oid) return jsonResponse(409, { message: 'sha does not match the current file' });
    } else if (givenSha !== undefined) {
      return unprocessable('sha does not match: the file does not exist');
    }
    const blobOid = store.addObject(repo, 'blob', contentBytes);
    const newTree = setPathInTree(baseTree, path, blobOid, lookup, (type, data) =>
      store.addObject(repo, type, data),
    );
    const commitOid = store.addObject(
      repo,
      'commit',
      buildCommit({ tree: newTree, parents: head === null ? [] : [head.oid], message, timestamp: Math.floor(Date.now() / 1000) }),
    );
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return jsonResponse(existing ? 200 : 201, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: contentBytes.length, encoding: 'base64' },
      commit: { sha: commitOid, message },
    });
  }

  if (method === 'DELETE') {
    const body = isJsonObject(request.json) ? request.json : {};
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const head = store.commitOf(repo, `refs/heads/${branch}`);
    if (!head) return notFound('Not Found');
    const flat = flattenTree(head.commit.tree, lookup);
    if (!flat.has(path)) return notFound('Not Found');
    const newTree = setPathInTree(head.commit.tree, path, null, lookup, (type, data) =>
      store.addObject(repo, type, data),
    );
    const commitOid = store.addObject(
      repo,
      'commit',
      buildCommit({ tree: newTree, parents: [head.oid], message, timestamp: Math.floor(Date.now() / 1000) }),
    );
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return jsonResponse(200, { commit: { sha: commitOid, message } });
  }

  return jsonResponse(405, { message: 'Method Not Allowed' });
}

function handleIssues(store: Store, repo: Repo, tail: string[], request: RestRequest): HttpResponse {
  const { method } = request;
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = request.json;
      if (!isJsonObject(body)) return badRequest('request body must be a JSON object');
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return unprocessable('title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.some((known) => known.name === label)) {
          return unprocessable(`Label ${label} does not exist`);
        }
      }
      const issue = store.createIssue(repo, {
        title,
        body: typeof body.body === 'string' ? body.body : undefined,
        labels,
      });
      return jsonResponse(201, store.issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const direction = request.query.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      else if (state !== 'all') return unprocessable(`unknown state ${state}`);
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return jsonList(issues.map((issue) => store.issueJson(repo, issue)), request.query, request.host, request.pathname);
    }
    return jsonResponse(405, { message: 'Method Not Allowed' });
  }

  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isInteger(number) || number < 1) return notFound('Not Found');
  const issue = issueOr404(repo, number);
  if ('status' in issue) return issue;

  if (tail.length === 1) {
    if (method === 'GET') return jsonResponse(200, store.issueJson(repo, issue));
    if (method === 'PATCH') {
      const body = request.json;
      if (!isJsonObject(body)) return badRequest('request body must be a JSON object');
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? new Date().toISOString() : null;
      }
      issue.updatedAt = new Date().toISOString();
      return jsonResponse(200, store.issueJson(repo, issue));
    }
    return jsonResponse(405, { message: 'Method Not Allowed' });
  }

  if (tail[1] === 'comments') {
    if (method === 'POST') {
      const body = request.json;
      if (!isJsonObject(body)) return badRequest('request body must be a JSON object');
      const commentBody = typeof body.body === 'string' ? body.body : '';
      if (commentBody === '') return unprocessable('body is required');
      const comment = store.createComment(repo, issue, commentBody);
      return jsonResponse(201, store.commentJson(repo, comment));
    }
    if (method === 'GET') {
      return jsonResponse(200, issue.comments.map((comment) => store.commentJson(repo, comment)));
    }
    return jsonResponse(405, { message: 'Method Not Allowed' });
  }

  return notFound('Not Found');
}

function handlePulls(store: Store, repo: Repo, tail: string[], request: RestRequest): HttpResponse {
  const { method } = request;
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = request.json;
      if (!isJsonObject(body)) return badRequest('request body must be a JSON object');
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      if (title === '' || head === '' || base === '') return unprocessable('title, head and base are required');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return unprocessable('head or base branch does not exist');
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate) return unprocessable('A pull request already exists for this head and base');
      const pull = store.createPull(repo, {
        title,
        body: typeof body.body === 'string' ? body.body : undefined,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
      });
      return jsonResponse(201, store.pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      else if (state !== 'all') return unprocessable(`unknown state ${state}`);
      pulls.sort((a, b) => b.seq - a.seq);
      return jsonList(pulls.map((pull) => store.pullJson(repo, pull)), request.query, request.host, request.pathname);
    }
    return jsonResponse(405, { message: 'Method Not Allowed' });
  }

  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isInteger(number) || number < 1) return notFound('Not Found');
  const pull = pullOr404(repo, number);
  if ('status' in pull) return pull;

  if (tail.length === 1) {
    if (method === 'GET') return jsonResponse(200, store.pullJson(repo, pull));
    return jsonResponse(405, { message: 'Method Not Allowed' });
  }

  if (tail[1] === 'files' && method === 'GET') {
    const lookup = store.lookup(repo);
    const head = store.commitOf(repo, `refs/heads/${pull.headRef}`);
    const base = store.commitOf(repo, `refs/heads/${pull.baseRef}`);
    if (!head || !base) return notFound('Not Found');
    const baseOid = mergeBase(head.oid, base.oid, lookup);
    const baseTree = baseOid === null ? null : store.treeOfCommit(repo, baseOid);
    const files = diffTrees(baseTree, head.commit.tree, lookup).map((entry) => ({
      filename: entry.path,
      status: entry.status === 'added' ? 'added' : entry.status === 'deleted' ? 'removed' : 'modified',
      additions: entry.additions,
      deletions: entry.deletions,
      changes: entry.changes,
    }));
    return jsonResponse(200, files);
  }

  if (tail[1] === 'merge' && method === 'PUT') {
    const body = isJsonObject(request.json) ? request.json : {};
    const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
    if (pull.state === 'closed') return jsonResponse(405, { message: 'Pull request is already closed' });
    const result = store.mergePull(repo, pull, mergeMethod);
    if (!result.merged) {
      if (result.conflicts && result.conflicts.length > 0) {
        return jsonResponse(405, { message: `Merge conflict in ${result.conflicts.join(', ')}` });
      }
      return jsonResponse(405, { message: 'Pull request cannot be merged' });
    }
    return jsonResponse(200, { merged: true, sha: result.sha, message: result.message });
  }

  return notFound('Not Found');
}
