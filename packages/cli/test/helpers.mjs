/**
 * Shared test helpers: a stub API server whose routes each test file
 * defines, and an in-process CLI runner that records every request.
 */
import { createServer } from "node:http";
import { run } from "../dist/index.js";

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "x-request-id": "req-cli", ...headers });
  res.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Starts a stub server. `handler({ method, path, url, body, headers }, res)`
 * answers (returns false/undefined after sending). Unknown routes get 404.
 */
export async function stubServer(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = await readBody(req);
    const request = { method: req.method, path: url.pathname, url, body, headers: req.headers };
    requests.push(request);
    try {
      const handled = await handler(request, res);
      if (handled === false || !res.headersSent) send(res, 404, { error: { code: "NOT_FOUND", message: `No route for ${req.method} ${url.pathname}` } });
    } catch (error) {
      if (!res.headersSent) send(res, 500, { error: { code: "INTERNAL_ERROR", message: String(error) } });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

/** Runs the CLI in-process; `tty` makes stdout look like a terminal. */
export async function cli(args, { base, env = {}, tty = false, stdin, fetch: fetchImpl } = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    stdout: { write: (chunk) => { stdout += chunk; }, isTTY: tty },
    stderr: { write: (chunk) => { stderr += chunk; } },
    env: { ...(base ? { KLETIA_BASE_URL: base } : {}), ...env },
    ...(stdin !== undefined ? { readStdin: async () => stdin } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return { code, stdout, stderr };
}
