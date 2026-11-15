// The forge server: one process, one Store, four surfaces — git
// smart HTTP, REST v3, GraphQL v4 and MCP. main.ts owns the entry's
// lifecycle with the environment; this file is the HTTP server that
// main.ts binds to an ephemeral port.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { RestHandler } from './rest.ts';
import { GraphqlHandler } from './graphql.ts';
import { McpHandler } from './mcp.ts';
import { handleInfoRefs, handleUploadPackV2, handleUploadPackV0, handleReceivePack } from './git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

// Answer one request with a JSON body. Extra `headers` are sent
// beside the JSON content-type and content-length headers.
function replyJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  // Encode once: the Buffer gives both the wire bytes and their length,
  // instead of one UTF-8 pass for the length and a second to send it.
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': bytes.length, ...headers });
  res.end(bytes);
}

// Answer with an empty body (used for 204 and for 202 notifications).
function replyEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-length': 0, ...headers });
  res.end();
}

// Answer with raw bytes (git smart-HTTP responses carry their own
// content type, so no JSON headers are added here).
function replyRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

// Split a request URL into its path and its raw query string.
// Request targets here are always origin-form paths, so splitting on
// the first '?' is exact and avoids a full URL parse per request.
function splitPathAndQuery(req: IncomingMessage): { path: string; query: string } {
  try {
    const raw = req.url ?? '/';
    // Absolute-form targets (rare, proxy-style) still go through URL.
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      const url = new URL(raw);
      return { path: url.pathname, query: url.search.slice(1) };
    }
    const q = raw.indexOf('?');
    if (q < 0) return { path: raw, query: '' };
    return { path: raw.slice(0, q), query: raw.slice(q + 1) };
  } catch {
    return { path: '/', query: '' };
  }
}

// Read the whole request body into one Buffer.
function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  // GET/HEAD never carry a body in this API, and no body is declared:
  // resolve at once instead of waiting a turn for the stream to end.
  if ((req.method === 'GET' || req.method === 'HEAD') && !req.headers['content-length'] && !req.headers['transfer-encoding']) {
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Flatten Node's headers into a plain lower-cased map. A header
// sent more than once is joined with ", " into one value.
function flattenHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

// Build the server. It binds to nothing until the caller listens;
// the entry listens on an ephemeral port chosen by the OS.
export function createApp(): Server {
  const store = new Store();
  const rest = new RestHandler(store);
  const graphql = new GraphqlHandler(store);
  const mcp = new McpHandler(store);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const { path, query } = splitPathAndQuery(req);
      const method = req.method ?? 'GET';
      const headers = flattenHeaders(req);
      const host = headers['host'] ?? 'localhost';
      const bodyBuffer = await readRequestBody(req);
      const bodyText = bodyBuffer.toString('utf8');

      try {
        // The environment's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          replyJson(res, 200, { ok: true });
          return;
        }

        // MCP over streamable HTTP.
        if (path === '/mcp') {
          const result = mcp.handle(method, headers, bodyText);
          if (result.status === 202 || result.body === null) {
            replyEmpty(res, result.status === 202 ? 202 : result.status, result.headers ?? {});
          } else {
            replyJson(res, result.status, result.body, result.headers ?? {});
          }
          return;
        }

        // GraphQL v4 — POST only; anything else is a 404.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            replyJson(res, 404, { message: 'Not Found' });
            return;
          }
          const result = graphql.handle(headers, bodyText);
          replyJson(res, result.status, result.body);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs,
        // git-upload-pack and git-receive-pack.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const action = gitMatch[3];
          // A repo under a foreign owner is invisible to git, too:
          // the handlers below then answer 404 for it.
          const repo = owner === store.viewer.login ? (store.getRepo(owner, repoName) ?? undefined) : undefined;
          if (action === 'info/refs') {
            if (method !== 'GET') {
              replyJson(res, 404, { message: 'Not Found' });
              return;
            }
            const params = new URLSearchParams(query);
            const service = params.get('service') ?? '';
            const gitProtocol = headers['git-protocol'] ?? '';
            const result = handleInfoRefs(store, repo, service, gitProtocol);
            if (result.status !== 200) {
              replyJson(res, result.status, { message: 'Not Found' });
              return;
            }
            replyRaw(res, 200, result.body, result.contentType);
            return;
          }
          if (action === 'git-upload-pack') {
            if (method !== 'POST' || !repo) {
              replyJson(res, 404, { message: 'Not Found' });
              return;
            }
            const gitProtocol = headers['git-protocol'] ?? '';
            const result = gitProtocol === 'version=2'
              ? handleUploadPackV2(store, repo, bodyBuffer)
              : handleUploadPackV0(store, repo, bodyBuffer);
            if (result.status !== 200) {
              replyJson(res, result.status, { message: 'Not Found' });
              return;
            }
            replyRaw(res, 200, result.body, result.contentType);
            return;
          }
          // git-receive-pack: POST only, and the repo must exist.
          if (method !== 'POST' || !repo) {
            replyJson(res, 404, { message: 'Not Found' });
            return;
          }
          const result = handleReceivePack(store, repo, bodyBuffer);
          if (result.status !== 200) {
            replyJson(res, result.status, { message: 'Not Found' });
            return;
          }
          replyRaw(res, 200, result.body, result.contentType);
          return;
        }

        // REST v3 under /api/v3/... (the root is handled by RestHandler too).
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const restPath = path.slice('/api/v3'.length) || '/';
          const result = rest.handle(method, restPath, query, headers, bodyText, host);
          if (result.status === 204 || result.body === null) {
            replyEmpty(res, 204);
          } else {
            replyJson(res, result.status, result.body, result.headers);
          }
          return;
        }

        // Everything else, on every method: GitHub's 404 body.
        replyJson(res, 404, { message: 'Not Found' });
      } catch (caught) {
        if (!res.headersSent) {
          replyJson(res, 500, { message: caught instanceof Error ? caught.message : 'Internal error' });
        }
      }
    })();
  });
}
