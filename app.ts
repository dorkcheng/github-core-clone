// The HTTP server: one Store, one router. Routes:
//   GET  /healthz                                  no auth, the env's liveness probe
//   /{owner}/{repo}.git/info/refs                  git smart HTTP advertisement
//   /{owner}/{repo}.git/git-upload-pack            git fetch / ls-refs
//   /{owner}/{repo}.git/git-receive-pack           git push
//   /api/v3/*                                      REST v3
//   POST /api/graphql                              GraphQL v4
//   POST /mcp                                      MCP, streamable HTTP
// Every other path is a JSON 404. Every reply carries a non-empty X-GitHub-Request-Id.
// Auth: a Bearer token must equal MAKEFUN_SHOP_TOKEN, except GET /api/v3/ (the root) and
// /healthz. A missing or wrong token is 401 with a JSON message body.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, jsonResponse, type HttpResponse } from './git.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { Store } from './store.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, result: HttpResponse): void {
  const headers: Record<string, string> = {
    'x-github-request-id': randomUUID(),
    ...result.headers,
  };
  if (result.status === 401) {
    // A real git client only retries with its credentials when the 401 carries a challenge.
    headers['www-authenticate'] = 'Basic realm="forge"';
  }
  response.writeHead(result.status, headers);
  response.end(result.body);
}

/** The token a request carries: `Bearer <token>`, or the password (else the username) of a
 * Basic credential, which is how a real git client authenticates a smart-HTTP fetch. */
function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const bearer = /^Bearer (.+)$/.exec(header.trim());
  if (bearer !== null) return bearer[1] as string;
  const basic = /^Basic (.+)$/.exec(header.trim());
  if (basic !== null) {
    const decoded = Buffer.from(basic[1] as string, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return decoded === '' ? null : decoded;
    const password = decoded.slice(colon + 1);
    if (password !== '') return password;
    const username = decoded.slice(0, colon);
    return username === '' ? null : username;
  }
  return null;
}

function authorized(request: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  return bearerToken(request) === SHOP_TOKEN;
}

export function createApp(): Server {
  const store = new Store();
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        const method = request.method ?? 'GET';

        if (method === 'GET' && pathname === '/healthz') {
          send(response, { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch) {
          if (!authorized(request)) {
            send(response, jsonResponse(401, { message: 'Bad credentials' }));
            return;
          }
          const owner = gitMatch[1] as string;
          const repoName = gitMatch[2] as string;
          const service = gitMatch[3] as string;
          if (service === 'info/refs') {
            const serviceParam = url.searchParams.get('service') ?? '';
            send(response, handleInfoRefs(store, owner, repoName, serviceParam));
            return;
          }
          const body = await readBody(request);
          if (service === 'git-upload-pack') send(response, handleUploadPack(store, owner, repoName, body));
          else send(response, handleReceivePack(store, owner, repoName, body));
          return;
        }

        // GraphQL.
        if (pathname === '/api/graphql' && method === 'POST') {
          if (!authorized(request)) {
            send(response, jsonResponse(401, { message: 'Bad credentials' }));
            return;
          }
          const body = await readBody(request);
          send(response, handleGraphQL(store, body));
          return;
        }

        // MCP.
        if (pathname === '/mcp' && method === 'POST') {
          if (!authorized(request)) {
            send(response, jsonResponse(401, { message: 'Bad credentials' }));
            return;
          }
          const body = await readBody(request);
          send(response, handleMcp(store, body));
          return;
        }

        // REST v3.
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const isRoot = (pathname === '/api/v3' || pathname === '/api/v3/') && method === 'GET';
          if (!isRoot && !authorized(request)) {
            send(response, jsonResponse(401, { message: 'Bad credentials' }));
            return;
          }
          const body = await readBody(request);
          let json: unknown = null;
          if (body.length > 0) {
            try {
              json = JSON.parse(body.toString('utf8'));
            } catch {
              send(response, jsonResponse(400, { message: 'request body is not valid JSON' }));
              return;
            }
          }
          const restRequest: RestRequest = {
            method,
            pathname,
            query: url.searchParams,
            host: request.headers.host ?? 'localhost',
            body,
            json,
          };
          const result = handleRest(store, restRequest);
          if (result === null) {
            send(response, jsonResponse(404, { message: 'Not Found' }));
            return;
          }
          send(response, result);
          return;
        }

        send(response, jsonResponse(404, { message: 'Not Found' }));
      } catch (error) {
        // A handler must never take the server down: answer 500 JSON and keep serving.
        process.stderr.write(`[app] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        if (!response.headersSent) {
          send(response, jsonResponse(500, { message: 'Internal Server Error' }));
        } else {
          response.destroy();
        }
      }
    })();
  });
  return server;
}
