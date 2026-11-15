// GraphQL v4: a small hand-written parser and executor for the documents the suite sends
// (gh and github-mcp-server shapes): viewer, repository + issue/issues/pullRequest/pullRequests,
// node(id:) with inline fragments, __type introspection, and the five mutations. Batching
// (a JSON array of requests) is supported. An unknown field is a GraphQL-level error
// (HTTP 200 + errors), never an HTTP failure; an unknown repository is data null, no errors.

import {
  diffTrees, mergeBase, threeWayMergeTrees,
} from './gitcore.ts';
import type { HttpResponse } from './git.ts';
import { jsonResponse } from './git.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// global ids: opaque, stable across reads, base64url of a typed payload
// ---------------------------------------------------------------------------------------------

function encodeGlobalId(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeGlobalId(id: string): string | null {
  try {
    return Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function repositoryGlobalId(repo: Repo): string {
  return encodeGlobalId(`Repository:${repo.id}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId(`Issue:${repo.id}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeGlobalId(`PullRequest:${repo.id}:${pull.number}`);
}

function commentGlobalId(repo: Repo, commentId: number): string {
  return encodeGlobalId(`IssueComment:${repo.id}:${commentId}`);
}

function cursorFor(value: string): string {
  return encodeGlobalId(`cursor:${value}`);
}

function cursorValue(cursor: string): string | null {
  const decoded = decodeGlobalId(cursor);
  if (decoded === null || !decoded.startsWith('cursor:')) return null;
  return decoded.slice('cursor:'.length);
}

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' }
  | { kind: 'variable'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'variable', value: source.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      // Block strings (""") and ordinary strings.
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const escaped = source[j + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
          if (escaped === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += map[escaped] ?? escaped;
            j += 2;
          }
          continue;
        }
        value += source[j];
        j += 1;
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number.parseFloat(text) } : { kind: 'int', value: Number.parseInt(text, 10) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser: operations, fragments, fields, values
// ---------------------------------------------------------------------------------------------

export interface GqlValue {
  kind: 'string' | 'int' | 'float' | 'boolean' | 'null' | 'enum' | 'variable' | 'list' | 'object';
  value?: string | number | boolean | null;
  items?: GqlValue[];
  fields?: { name: string; value: GqlValue }[];
}

export interface GqlField {
  alias: string | null;
  name: string;
  args: { name: string; value: GqlValue }[];
  selection: GqlSelection[];
}

export type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'inline'; typeCondition: string | null; selection: GqlSelection[] }
  | { kind: 'spread'; name: string };

export interface GqlOperation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: { name: string; defaultValue: GqlValue | null }[];
  selection: GqlSelection[];
}

export interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string; selection: GqlSelection[] }>;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.index] as Token;
    this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token)}`);
    }
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      const name = this.next();
      if (name.kind !== 'name') throw new Error('directive name expected');
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: GqlSelection[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        const name = this.next();
        if (name.kind !== 'name') throw new Error('fragment name expected');
        const on = this.next();
        if (on.kind !== 'name' || on.value !== 'on') throw new Error('fragment spread requires "on"');
        const typeToken = this.next();
        if (typeToken.kind !== 'name') throw new Error('fragment type condition expected');
        this.skipDirectives();
        fragments.set(name.value, { typeCondition: typeToken.value, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName.kind === 'name') {
          name = maybeName.value;
          this.next();
        }
        const variables = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ kind: token.value as GqlOperation['kind'], name, variables, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)} at the document level`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): { name: string; defaultValue: GqlValue | null }[] {
    const definitions: { name: string; defaultValue: GqlValue | null }[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const variable = this.next();
        if (variable.kind !== 'variable') throw new Error('variable definition requires a $variable');
        this.expectPunct(':');
        this.parseType();
        let defaultValue: GqlValue | null = null;
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        this.skipDirectives();
        definitions.push({ name: variable.value, defaultValue });
      }
      this.expectPunct(')');
    }
    return definitions;
  }

  private parseType(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else if (token.kind === 'name') {
      this.next();
    } else {
      throw new Error('type expected');
    }
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeToken = this.next();
        if (typeToken.kind !== 'name') throw new Error('inline fragment type condition expected');
        this.skipDirectives();
        return { kind: 'inline', typeCondition: typeToken.value, selection: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        this.next();
        this.skipDirectives();
        return { kind: 'spread', name: next.value };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() };
    }
    if (token.kind !== 'name') throw new Error(`selection requires a field name, got ${JSON.stringify(token)}`);
    const first = this.next() as { kind: 'name'; value: string };
    let alias: string | null = null;
    let name = first.value;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = name;
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('field name expected after an alias');
      name = nameToken.value;
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selection: GqlSelection[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  private parseArguments(): { name: string; value: GqlValue }[] {
    const args: { name: string; value: GqlValue }[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const name = this.next();
        if (name.kind !== 'name') throw new Error('argument name expected');
        this.expectPunct(':');
        args.push({ name: name.value, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    switch (token.kind) {
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'variable':
        return { kind: 'variable', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null', value: null };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '[') {
          const items: GqlValue[] = [];
          while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
            items.push(this.parseValue());
          }
          this.expectPunct(']');
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: { name: string; value: GqlValue }[] = [];
          while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
            const name = this.next();
            if (name.kind !== 'name') throw new Error('object field name expected');
            this.expectPunct(':');
            fields.push({ name: name.value, value: this.parseValue() });
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected punctuation ${JSON.stringify(token.value)} in a value`);
      default:
        throw new Error(`unexpected token ${JSON.stringify(token)} in a value`);
    }
  }
}

function parseGraphQL(source: string): GqlDocument {
  return new Parser(lex(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// values: resolve variables and literals into plain JS values
// ---------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function resolveValue(value: GqlValue, variables: Variables): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'variable':
      return variables[value.value as string];
    case 'list':
      return (value.items ?? []).map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields ?? []) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
    default:
      return null;
  }
}

function argsOf(field: GqlField, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// schema model (for __type) and the field table
// ---------------------------------------------------------------------------------------------

interface FieldDef {
  type: string;
  resolve?: (ctx: ExecContext, value: unknown, args: Record<string, unknown>) => unknown;
}

interface TypeModel {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INTERFACE' | 'INPUT_OBJECT';
  fields?: string[];
  enumValues?: string[];
  description?: string;
}

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueOrderField: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'private',
    'isPrivate', 'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['name', 'target'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'files', 'author',
    'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'ofType', 'inputFields'],
  __Schema: ['queryType', 'mutationType', 'types', 'directives'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Directive: ['name', 'description', 'locations', 'args'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
};

function typeModel(name: string): TypeModel | null {
  if (OBJECT_FIELDS[name]) return { kind: 'OBJECT', fields: OBJECT_FIELDS[name] };
  if (ENUM_VALUES[name]) return { kind: 'ENUM', enumValues: ENUM_VALUES[name] };
  if (name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID') return { kind: 'SCALAR' };
  if (name === 'Node') return { kind: 'INTERFACE', fields: ['id'] };
  return null;
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  variables: Variables;
  errors: { message: string }[];
}

/** A resolved value carries its GraphQL type so sub-selections know their fields. */
interface TypedValue {
  type: string;
  value: unknown;
  /** For a List, the GraphQL type of each element (needed to execute a sub-selection). */
  elementType?: string;
}

function isObjectType(type: string): boolean {
  return OBJECT_FIELDS[type] !== undefined || type === 'Node';
}

function resolveRootField(ctx: ExecContext, field: GqlField, operationKind: string): TypedValue {
  const args = argsOf(field, ctx.variables);
  const store = ctx.store;
  if (operationKind === 'query') {
    if (field.name === 'viewer') {
      return { type: 'User', value: store.viewer };
    }
    if (field.name === 'repository') {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return { type: 'Repository', value: repo ?? null };
    }
    if (field.name === 'node') {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (decoded === null) return { type: 'Node', value: null };
      const [kind, ...rest] = decoded.split(':');
      if (kind === 'Repository') {
        const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(rest[0]));
        return { type: 'Repository', value: repo ?? null };
      }
      if (kind === 'Issue') {
        const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(rest[0]));
        const issue = repo?.issues.find((candidate) => candidate.number === Number(rest[1]));
        return { type: 'Issue', value: issue === undefined ? null : { repo, issue } };
      }
      if (kind === 'PullRequest') {
        const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(rest[0]));
        const pull = repo?.pulls.find((candidate) => candidate.number === Number(rest[1]));
        return { type: 'PullRequest', value: pull === undefined ? null : { repo, pull } };
      }
      return { type: 'Node', value: null };
    }
    if (field.name === '__type') {
      const model = typeModel(String(args.name ?? ''));
      return { type: '__Type', value: model === null ? null : { name: String(args.name), ...model } };
    }
    if (field.name === '__schema') {
      return { type: '__Schema', value: { queryType: 'Query', mutationType: 'Mutation' } };
    }
    throw new Error(`Cannot query field "${field.name}" on type "Query".`);
  }
  // Mutations.
  if (field.name === 'createIssue') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const [kind, dbId] = (decoded ?? '').split(':');
    const repo = kind === 'Repository' ? [...store.repos.values()].find((candidate) => candidate.id === Number(dbId)) : undefined;
    if (!repo) throw new Error('createIssue: repository not found');
    const issue = store.createIssue(repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : undefined });
    return { type: 'CreateIssuePayload', value: { issue: { repo, issue }, clientMutationId: input.clientMutationId ?? null } };
  }
  if (field.name === 'closeIssue') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    const [kind, dbId, number] = (decoded ?? '').split(':');
    const repo = kind === 'Issue' ? [...store.repos.values()].find((candidate) => candidate.id === Number(dbId)) : undefined;
    const issue = repo?.issues.find((candidate) => candidate.number === Number(number));
    if (!repo || !issue) throw new Error('closeIssue: issue not found');
    issue.state = 'closed';
    issue.closedAt = new Date().toISOString();
    issue.updatedAt = issue.closedAt;
    return { type: 'CloseIssuePayload', value: { issue: { repo, issue }, clientMutationId: input.clientMutationId ?? null } };
  }
  if (field.name === 'createPullRequest') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const [kind, dbId] = (decoded ?? '').split(':');
    const repo = kind === 'Repository' ? [...store.repos.values()].find((candidate) => candidate.id === Number(dbId)) : undefined;
    if (!repo) throw new Error('createPullRequest: repository not found');
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) throw new Error('createPullRequest: head or base branch does not exist');
    const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
    if (duplicate) throw new Error('createPullRequest: a pull request already exists for this head and base');
    const pull = store.createPull(repo, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : undefined,
      headRef,
      baseRef,
      headSha,
      baseSha,
    });
    return { type: 'CreatePullRequestPayload', value: { pullRequest: { repo, pull }, clientMutationId: input.clientMutationId ?? null } };
  }
  if (field.name === 'mergePullRequest') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    const [kind, dbId, number] = (decoded ?? '').split(':');
    const repo = kind === 'PullRequest' ? [...store.repos.values()].find((candidate) => candidate.id === Number(dbId)) : undefined;
    const pull = repo?.pulls.find((candidate) => candidate.number === Number(number));
    if (!repo || !pull) throw new Error('mergePullRequest: pull request not found');
    const merged = mergePullRequestNow(ctx.store, repo, pull, String(input.mergeMethod ?? 'SQUASH'));
    if (!merged) throw new Error('mergePullRequest: merge conflict');
    return { type: 'MergePullRequestPayload', value: { pullRequest: { repo, pull }, clientMutationId: input.clientMutationId ?? null } };
  }
  if (field.name === 'addComment') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    const [kind, dbId, number] = (decoded ?? '').split(':');
    const repo = kind === 'Issue' ? [...store.repos.values()].find((candidate) => candidate.id === Number(dbId)) : undefined;
    const issue = repo?.issues.find((candidate) => candidate.number === Number(number));
    if (!repo || !issue) throw new Error('addComment: issue not found');
    const comment = store.createComment(repo, issue, String(input.body ?? ''));
    return { type: 'AddCommentPayload', value: { commentEdge: { node: { repo, comment }, cursor: cursorFor(`comment:${comment.id}`) }, clientMutationId: input.clientMutationId ?? null } };
  }
  throw new Error(`Cannot query field "${field.name}" on type "Mutation".`);
}

/** Squash-merge a pull request the way the REST merge does; false on conflict. */
function mergePullRequestNow(store: Store, repo: Repo, pull: Pull, mergeMethod: string): boolean {
  return store.mergePull(repo, pull, mergeMethod).merged;
}

/** Resolve one field of a typed value. Returns null for an unknown field (the caller records the error). */
function resolveField(ctx: ExecContext, type: string, value: unknown, field: GqlField): TypedValue | null {
  const args = argsOf(field, ctx.variables);
  const store = ctx.store;
  const name = field.name;

  // __typename is always available.
  if (name === '__typename') return { type: 'String', value: type };

  switch (type) {
    case 'User': {
      const user = value as Store['viewer'];
      if (name === 'login') return { type: 'String', value: user.login };
      if (name === 'id') return { type: 'ID', value: encodeGlobalId(`User:${user.id}`) };
      if (name === 'name') return { type: 'String', value: user.name };
      if (name === 'email') return { type: 'String', value: user.email };
      if (name === 'avatarUrl') return { type: 'String', value: `https://avatars.githubusercontent.com/u/${user.id}?v=4` };
      if (name === 'url') return { type: 'String', value: `https://github.com/${user.login}` };
      return null;
    }
    case 'Repository': {
      const repo = value as Repo;
      if (name === 'id') return { type: 'ID', value: repositoryGlobalId(repo) };
      if (name === 'databaseId') return { type: 'Int', value: repo.id };
      if (name === 'name') return { type: 'String', value: repo.name };
      if (name === 'nameWithOwner') return { type: 'String', value: `${repo.owner}/${repo.name}` };
      if (name === 'description') return { type: 'String', value: repo.description };
      if (name === 'private' || name === 'isPrivate') return { type: 'Boolean', value: repo.isPrivate };
      if (name === 'createdAt') return { type: 'String', value: repo.createdAt };
      if (name === 'updatedAt') return { type: 'String', value: repo.updatedAt };
      if (name === 'url') return { type: 'String', value: `https://github.com/${repo.owner}/${repo.name}` };
      if (name === 'owner') return { type: 'User', value: store.viewer };
      if (name === 'defaultBranchRef') {
        const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return { type: 'Ref', value: sha === undefined ? null : { name: repo.defaultBranch, sha } };
      }
      if (name === 'viewerPermission') return { type: 'RepositoryPermission', value: 'ADMIN' };
      if (name === 'hasIssuesEnabled') return { type: 'Boolean', value: true };
      if (name === 'issue') {
        const issue = repo.issues.find((candidate) => candidate.number === Number(args.number));
        return { type: 'Issue', value: issue === undefined ? null : { repo, issue } };
      }
      if (name === 'issues') return { type: 'IssueConnection', value: issueConnection(repo, args) };
      if (name === 'pullRequest') {
        const pull = repo.pulls.find((candidate) => candidate.number === Number(args.number));
        return { type: 'PullRequest', value: pull === undefined ? null : { repo, pull } };
      }
      if (name === 'pullRequests') return { type: 'PullRequestConnection', value: pullRequestConnection(repo, args) };
      return null;
    }
    case 'Ref': {
      const ref = value as { name: string; sha: string };
      if (name === 'name') return { type: 'String', value: ref.name };
      if (name === 'target') return { type: 'String', value: ref.sha };
      return null;
    }
    case 'Issue': {
      const wrapped = value as { repo: Repo; issue: Issue };
      const { repo, issue } = wrapped;
      if (name === 'id') return { type: 'ID', value: issueGlobalId(repo, issue) };
      if (name === 'databaseId') return { type: 'Int', value: issue.id };
      if (name === 'number') return { type: 'Int', value: issue.number };
      if (name === 'title') return { type: 'String', value: issue.title };
      if (name === 'body') return { type: 'String', value: issue.body };
      if (name === 'state') return { type: 'IssueState', value: issue.state.toUpperCase() };
      if (name === 'author') return { type: 'User', value: store.viewer };
      if (name === 'createdAt') return { type: 'String', value: issue.createdAt };
      if (name === 'updatedAt') return { type: 'String', value: issue.updatedAt };
      if (name === 'closedAt') return { type: 'String', value: issue.closedAt };
      if (name === 'url') return { type: 'String', value: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}` };
      if (name === 'labels') {
        const labels = issue.labelNames
          .map((labelName) => repo.labels.find((label) => label.name === labelName))
          .filter((label): label is NonNullable<typeof label> => label !== undefined);
        return { type: 'LabelConnection', value: { nodes: labels } };
      }
      if (name === 'comments') {
        return {
          type: 'IssueCommentConnection',
          value: {
            nodes: issue.comments.map((comment) => ({ repo, comment })),
            totalCount: issue.comments.length,
          },
        };
      }
      return null;
    }
    case 'PullRequest': {
      const wrapped = value as { repo: Repo; pull: Pull };
      const { repo, pull } = wrapped;
      if (name === 'id') return { type: 'ID', value: pullGlobalId(repo, pull) };
      if (name === 'databaseId') return { type: 'Int', value: pull.id };
      if (name === 'number') return { type: 'Int', value: pull.number };
      if (name === 'title') return { type: 'String', value: pull.title };
      if (name === 'body') return { type: 'String', value: pull.body };
      if (name === 'state') return { type: 'PullRequestState', value: pull.merged ? 'MERGED' : pull.state.toUpperCase() };
      if (name === 'merged') return { type: 'Boolean', value: pull.merged };
      if (name === 'mergedAt') return { type: 'String', value: pull.mergedAt };
      if (name === 'mergeCommit') return { type: 'String', value: pull.mergeCommitSha };
      if (name === 'headRefName') return { type: 'String', value: pull.headRef };
      if (name === 'baseRefName') return { type: 'String', value: pull.baseRef };
      if (name === 'headRef') return { type: 'Ref', value: { name: pull.headRef, sha: repo.refs.get(`refs/heads/${pull.headRef}`) ?? '' } };
      if (name === 'baseRef') return { type: 'Ref', value: { name: pull.baseRef, sha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '' } };
      if (name === 'author') return { type: 'User', value: store.viewer };
      if (name === 'createdAt') return { type: 'String', value: pull.createdAt };
      if (name === 'updatedAt') return { type: 'String', value: pull.updatedAt };
      if (name === 'closedAt') return { type: 'String', value: pull.state === 'closed' ? pull.updatedAt : null };
      if (name === 'url') return { type: 'String', value: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}` };
      if (name === 'mergeable') {
        const lookup = store.lookup(repo);
        const head = store.commitOf(repo, `refs/heads/${pull.headRef}`);
        const base = store.commitOf(repo, `refs/heads/${pull.baseRef}`);
        if (!head || !base) return { type: 'MergeableState', value: 'UNKNOWN' };
        const baseOid = mergeBase(head.oid, base.oid, lookup);
        const baseTree = baseOid === null ? null : store.treeOfCommit(repo, baseOid);
        const { conflicts } = threeWayMergeTrees(baseTree, base.commit.tree, head.commit.tree, lookup, (typeName, data) =>
          store.addObject(repo, typeName, data),
        );
        return { type: 'MergeableState', value: conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE' };
      }
      if (name === 'files') {
        const lookup = store.lookup(repo);
        const head = store.commitOf(repo, `refs/heads/${pull.headRef}`);
        const base = store.commitOf(repo, `refs/heads/${pull.baseRef}`);
        if (!head || !base) return { type: 'PullRequestFileConnection', value: { nodes: [], totalCount: 0 } };
        const baseOid = mergeBase(head.oid, base.oid, lookup);
        const baseTree = baseOid === null ? null : store.treeOfCommit(repo, baseOid);
        const entries = diffTrees(baseTree, head.commit.tree, lookup).map((entry) => ({
          path: entry.path,
          additions: entry.additions,
          deletions: entry.deletions,
          changeType: entry.status === 'added' ? 'ADDED' : entry.status === 'deleted' ? 'DELETED' : 'MODIFIED',
        }));
        return { type: 'PullRequestFileConnection', value: { nodes: entries, totalCount: entries.length } };
      }
      return null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'IssueCommentConnection':
    case 'PullRequestFileConnection':
    case 'LabelConnection': {
      const connection = value as { nodes: unknown[]; totalCount?: number };
      if (name === 'nodes') {
        return { type: 'List', elementType: connectionNodeType(type), value: connection.nodes };
      }
      if (name === 'totalCount') return { type: 'Int', value: connection.totalCount ?? connection.nodes.length };
      if (name === 'edges') {
        const edgeType =
          type === 'IssueConnection'
            ? 'IssueEdge'
            : type === 'PullRequestConnection'
              ? 'PullRequestEdge'
              : type === 'IssueCommentConnection'
                ? 'IssueCommentEdge'
                : type === 'PullRequestFileConnection'
                  ? 'PullRequestFileEdge'
                  : 'IssueEdge';
        return {
          type: 'List',
          elementType: edgeType,
          value: connection.nodes.map((node) => ({ node, cursor: cursorFor(edgeKey(node)) })),
        };
      }
      if (name === 'pageInfo') return { type: 'PageInfo', value: connection };
      return null;
    }
    case 'PageInfo': {
      const connection = value as { nodes: unknown[]; pageInfo?: { hasNextPage: boolean; startCursor: string | null; endCursor: string | null } };
      const info = connection.pageInfo ?? { hasNextPage: false, startCursor: null, endCursor: null };
      if (name === 'hasNextPage') return { type: 'Boolean', value: info.hasNextPage };
      if (name === 'hasPreviousPage') return { type: 'Boolean', value: false };
      if (name === 'startCursor') return { type: 'String', value: info.startCursor };
      if (name === 'endCursor') return { type: 'String', value: info.endCursor };
      return null;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'IssueCommentEdge':
    case 'PullRequestFileEdge': {
      const edge = value as { node: unknown; cursor: string };
      if (name === 'node') {
        const edgeType =
          type === 'IssueEdge' ? 'Issue' : type === 'PullRequestEdge' ? 'PullRequest' : type === 'IssueCommentEdge' ? 'IssueComment' : 'PullRequestFile';
        return { type: edgeType, value: edge.node };
      }
      if (name === 'cursor') return { type: 'String', value: edge.cursor };
      return null;
    }
    case 'Label': {
      const label = value as { name: string; color: string; description: string; id: number };
      if (name === 'id') return { type: 'ID', value: encodeGlobalId(`Label:${label.id}`) };
      if (name === 'name') return { type: 'String', value: label.name };
      if (name === 'color') return { type: 'String', value: label.color };
      if (name === 'description') return { type: 'String', value: label.description };
      return null;
    }
    case 'IssueComment': {
      const wrapped = value as { repo: Repo; comment: { id: number; body: string; createdAt: string; updatedAt: string } };
      if (name === 'id') return { type: 'ID', value: commentGlobalId(wrapped.repo, wrapped.comment.id) };
      if (name === 'databaseId') return { type: 'Int', value: wrapped.comment.id };
      if (name === 'body') return { type: 'String', value: wrapped.comment.body };
      if (name === 'author') return { type: 'User', value: store.viewer };
      if (name === 'createdAt') return { type: 'String', value: wrapped.comment.createdAt };
      if (name === 'updatedAt') return { type: 'String', value: wrapped.comment.updatedAt };
      if (name === 'url') return { type: 'String', value: `https://github.com/${wrapped.repo.owner}/${wrapped.repo.name}/issues/comments/${wrapped.comment.id}` };
      return null;
    }
    case 'PullRequestFile': {
      const file = value as { path: string; additions: number; deletions: number; changeType: string };
      if (name === 'path') return { type: 'String', value: file.path };
      if (name === 'additions') return { type: 'Int', value: file.additions };
      if (name === 'deletions') return { type: 'Int', value: file.deletions };
      if (name === 'changeType') return { type: 'String', value: file.changeType };
      return null;
    }
    case '__Type': {
      const model = value as TypeModel & { name: string };
      if (name === 'name') return { type: 'String', value: model.name };
      if (name === 'kind') return { type: 'String', value: model.kind };
      if (name === 'description') return { type: 'String', value: model.description ?? null };
      if (name === 'fields') {
        const fields = (model.fields ?? []).map((fieldName) => ({ name: fieldName }));
        return { type: 'List', elementType: '__Field', value: fields };
      }
      if (name === 'enumValues') {
        const values = (model.enumValues ?? []).map((enumName) => ({ name: enumName }));
        return { type: 'List', elementType: '__EnumValue', value: values };
      }
      if (name === 'ofType') return { type: '__Type', value: null };
      if (name === 'inputFields') return { type: 'List', elementType: '__InputValue', value: [] };
      return null;
    }
    case '__Schema': {
      if (name === 'queryType') return { type: '__Type', value: { name: 'Query', kind: 'OBJECT', fields: OBJECT_FIELDS.Query } };
      if (name === 'mutationType') return { type: '__Type', value: { name: 'Mutation', kind: 'OBJECT', fields: OBJECT_FIELDS.Mutation } };
      if (name === 'types') {
        return {
          type: 'List',
          elementType: '__Type',
          value: Object.keys(OBJECT_FIELDS).map((typeName) => ({ name: typeName, kind: 'OBJECT', fields: OBJECT_FIELDS[typeName] })),
        };
      }
      if (name === 'directives') return { type: 'List', elementType: '__Directive', value: [] };
      return null;
    }
    case '__Field': {
      const field = value as { name: string };
      if (name === 'name') return { type: 'String', value: field.name };
      if (name === 'description') return { type: 'String', value: null };
      if (name === 'args') return { type: 'List', elementType: '__InputValue', value: [] };
      if (name === 'type') return { type: '__Type', value: { name: 'String', kind: 'SCALAR' } };
      if (name === 'isDeprecated') return { type: 'Boolean', value: false };
      if (name === 'deprecationReason') return { type: 'String', value: null };
      return null;
    }
    case '__EnumValue': {
      const enumValue = value as { name: string };
      if (name === 'name') return { type: 'String', value: enumValue.name };
      if (name === 'description') return { type: 'String', value: null };
      if (name === 'isDeprecated') return { type: 'Boolean', value: false };
      if (name === 'deprecationReason') return { type: 'String', value: null };
      return null;
    }
    case 'CreateIssuePayload': {
      const payload = value as { issue: { repo: Repo; issue: Issue }; clientMutationId: unknown };
      if (name === 'issue') return { type: 'Issue', value: payload.issue };
      if (name === 'clientMutationId') return { type: 'String', value: payload.clientMutationId };
      return null;
    }
    case 'CloseIssuePayload': {
      const payload = value as { issue: { repo: Repo; issue: Issue }; clientMutationId: unknown };
      if (name === 'issue') return { type: 'Issue', value: payload.issue };
      if (name === 'clientMutationId') return { type: 'String', value: payload.clientMutationId };
      return null;
    }
    case 'CreatePullRequestPayload': {
      const payload = value as { pullRequest: { repo: Repo; pull: Pull }; clientMutationId: unknown };
      if (name === 'pullRequest') return { type: 'PullRequest', value: payload.pullRequest };
      if (name === 'clientMutationId') return { type: 'String', value: payload.clientMutationId };
      return null;
    }
    case 'MergePullRequestPayload': {
      const payload = value as { pullRequest: { repo: Repo; pull: Pull }; clientMutationId: unknown };
      if (name === 'pullRequest') return { type: 'PullRequest', value: payload.pullRequest };
      if (name === 'clientMutationId') return { type: 'String', value: payload.clientMutationId };
      return null;
    }
    case 'AddCommentPayload': {
      const payload = value as { commentEdge: { node: unknown; cursor: string }; clientMutationId: unknown };
      if (name === 'commentEdge') return { type: 'IssueCommentEdge', value: payload.commentEdge };
      if (name === 'clientMutationId') return { type: 'String', value: payload.clientMutationId };
      return null;
    }
    default:
      return null;
  }
}

/** The item type of a connection's nodes, for executing a sub-selection on each node. */
function connectionNodeType(connectionType: string): string {
  if (connectionType === 'IssueConnection') return 'Issue';
  if (connectionType === 'PullRequestConnection') return 'PullRequest';
  if (connectionType === 'IssueCommentConnection') return 'IssueComment';
  if (connectionType === 'PullRequestFileConnection') return 'PullRequestFile';
  if (connectionType === 'LabelConnection') return 'Label';
  return 'String';
}

/** The stable cursor key of a connection node, so an edge cursor round-trips like endCursor. */
function edgeKey(node: unknown): string {
  const record = node as Record<string, unknown>;
  if (record && typeof record === 'object') {
    if ('issue' in record) return `issue:${(record.issue as { number: number }).number}`;
    if ('pull' in record) return `pull:${(record.pull as { number: number }).number}`;
    if ('comment' in record) return `comment:${(record.comment as { id: number }).id}`;
    if ('path' in record) return `file:${record.path as string}`;
    if ('name' in record) return `label:${record.name as string}`;
  }
  return 'edge:0';
}

/** Paginate a list of items by an opaque cursor and a first count. */
function paginateNodes<T>(items: readonly T[], key: (item: T) => string, first: number | undefined, after: string | undefined): {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; startCursor: string | null; endCursor: string | null };
} {
  let start = 0;
  if (after !== undefined && after !== null) {
    const value = cursorValue(after);
    if (value !== null) {
      const index = items.findIndex((item) => key(item) === value);
      if (index >= 0) start = index + 1;
    }
  }
  const count = first === undefined ? items.length : Math.max(0, first);
  const nodes = items.slice(start, start + count);
  const hasNextPage = start + nodes.length < items.length;
  const startCursor = nodes.length ? cursorFor(key(nodes[0] as T)) : null;
  const endCursor = nodes.length ? cursorFor(key(nodes[nodes.length - 1] as T)) : null;
  return { nodes: [...nodes], pageInfo: { hasNextPage, startCursor, endCursor } };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): {
  nodes: { repo: Repo; issue: Issue }[];
  totalCount: number;
  pageInfo: { hasNextPage: boolean; startCursor: string | null; endCursor: string | null };
} {
  let issues = [...repo.issues];
  const states = Array.isArray(args.states) ? (args.states as string[]) : [];
  if (states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = String(orderBy.field ?? 'CREATED_AT');
  const direction = String(orderBy.direction ?? 'DESC');
  issues.sort((a, b) => {
    const compare = field === 'UPDATED_AT' ? a.updatedAt.localeCompare(b.updatedAt) : a.seq - b.seq;
    return direction === 'DESC' ? -compare : compare;
  });
  const first = typeof args.first === 'number' ? args.first : undefined;
  const after = typeof args.after === 'string' ? args.after : undefined;
  const page = paginateNodes(issues, (issue) => `issue:${issue.number}`, first, after);
  return { nodes: page.nodes.map((issue) => ({ repo, issue })), totalCount: issues.length, pageInfo: page.pageInfo };
}

function pullRequestConnection(repo: Repo, args: Record<string, unknown>): {
  nodes: { repo: Repo; pull: Pull }[];
  totalCount: number;
  pageInfo: { hasNextPage: boolean; startCursor: string | null; endCursor: string | null };
} {
  let pulls = [...repo.pulls];
  const states = Array.isArray(args.states) ? (args.states as string[]) : [];
  if (states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    pulls = pulls.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
  }
  pulls.sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : undefined;
  const after = typeof args.after === 'string' ? args.after : undefined;
  const page = paginateNodes(pulls, (pull) => `pull:${pull.number}`, first, after);
  return { nodes: page.nodes.map((pull) => ({ repo, pull })), totalCount: pulls.length, pageInfo: page.pageInfo };
}

/** Execute a selection set against a typed value, building the JSON result. */
function executeSelection(
  ctx: ExecContext,
  doc: GqlDocument,
  type: string,
  value: unknown,
  selections: GqlSelection[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = doc.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition && fragment.typeCondition !== type) continue;
      Object.assign(out, executeSelection(ctx, doc, type, value, fragment.selection));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition && selection.typeCondition !== type) continue;
      Object.assign(out, executeSelection(ctx, doc, type, value, selection.selection));
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const resolved = resolveField(ctx, type, value, field);
    if (resolved === null) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${type}".` });
      out[key] = null;
      continue;
    }
    out[key] = executeValue(ctx, doc, resolved, field.selection);
  }
  return out;
}

/** Execute a resolved value: scalars pass through, objects recurse, lists map. */
function executeValue(ctx: ExecContext, doc: GqlDocument, resolved: TypedValue, selections: GqlSelection[]): unknown {
  const { type, value } = resolved;
  if (value === null || value === undefined) return null;
  if (type === 'List') {
    const items = value as unknown[];
    const elementType = resolved.elementType;
    if (elementType === undefined || !isObjectType(elementType)) return items;
    if (selections.length === 0) return items.map(() => ({}));
    return items.map((item) => executeSelection(ctx, doc, elementType, item, selections));
  }
  if (isObjectType(type)) {
    if (selections.length === 0) return {};
    return executeSelection(ctx, doc, type, value, selections);
  }
  return value;
}

function executeOperation(ctx: ExecContext, doc: GqlDocument, operation: GqlOperation): Record<string, unknown> {
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const out: Record<string, unknown> = {};
  for (const selection of operation.selection) {
    if (selection.kind !== 'field') {
      // Inline fragments and spreads at the root are unusual; apply them against the root type.
      if (selection.kind === 'inline') {
        if (selection.typeCondition && selection.typeCondition !== rootType) continue;
        Object.assign(out, executeSelection(ctx, doc, rootType, null, selection.selection));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    let resolved: TypedValue;
    try {
      resolved = resolveRootField(ctx, field, operation.kind);
    } catch (error) {
      ctx.errors.push({ message: (error as Error).message });
      out[key] = null;
      continue;
    }
    if (resolved.value === null) {
      out[key] = null;
      continue;
    }
    out[key] = executeValue(ctx, doc, resolved, field.selection);
  }
  return out;
}

function executeDocument(store: Store, doc: GqlDocument, variables: Variables, operationName: string | null): {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
} {
  const ctx: ExecContext = { store, variables, errors: [] };
  let operation: GqlOperation | null = doc.operations[0] ?? null;
  if (operationName !== null) {
    operation = doc.operations.find((candidate) => candidate.name === operationName) ?? null;
  } else if (doc.operations.length > 1) {
    ctx.errors.push({ message: 'Must provide operation name if query contains multiple operations.' });
    return { data: null, errors: ctx.errors };
  }
  if (operation === null) {
    ctx.errors.push({ message: operationName === null ? 'No operation found in the document.' : `Unknown operation named "${operationName}".` });
    return { data: null, errors: ctx.errors };
  }
  // Apply variable defaults, then the supplied variables.
  const merged: Variables = {};
  for (const definition of operation.variables) {
    if (definition.defaultValue !== null) merged[definition.name] = resolveValue(definition.defaultValue, variables);
  }
  for (const [key, value] of Object.entries(variables)) merged[key] = value;
  ctx.variables = merged;
  const data = executeOperation(ctx, doc, operation);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

export function handleGraphQL(store: Store, body: Buffer): HttpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonResponse(400, { message: 'request body is not valid JSON' });
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const results = requests.map((request) => {
    if (typeof request !== 'object' || request === null) {
      return { data: null, errors: [{ message: 'request must be an object' }] };
    }
    const record = request as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables ?? {}) as Variables;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let doc: GqlDocument;
    try {
      doc = parseGraphQL(query);
    } catch (error) {
      return { data: null, errors: [{ message: `GraphQL parse error: ${(error as Error).message}` }] };
    }
    return executeDocument(store, doc, variables, operationName);
  });
  return jsonResponse(200, Array.isArray(parsed) ? results : results[0]);
}
