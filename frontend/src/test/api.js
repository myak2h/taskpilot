import { vi } from "vitest";

let responses = new Map();
let requests = [];
let unexpectedRequests = [];

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function routeKey(method, path) {
  return `${method.toUpperCase()} ${path}`;
}

function validatePath(path) {
  if (typeof path !== "string" || !/^\/api(?:\/|\?|$)/.test(path)) {
    throw new Error(`Expected an exact /api path, received ${String(path)}`);
  }
}

const statusTexts = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Entity",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

function responseFor(body, status, statusText) {
  const serialized = status === 204 ? undefined : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async json() {
      if (status === 204) throw new SyntaxError("A 204 response has no JSON body");
      return JSON.parse(serialized);
    },
  };
}

export function installApiMock() {
  responses = new Map();
  requests = [];
  unexpectedRequests = [];

  const fetchMock = vi.fn(async (input, options = {}) => {
    const path = typeof input === "string" ? input : input.url ?? String(input);
    const method = (options.method ?? input.method ?? "GET").toUpperCase();
    const request = { method, path, body: undefined };
    requests.push(request);

    const key = routeKey(method, path);
    const queue = responses.get(key);
    if (!queue?.length) {
      const message = `Unexpected API request (no queued response): ${key}`;
      unexpectedRequests.push(message);
      throw new Error(message);
    }
    const response = queue.shift();

    try {
      const rawBody = options.body !== undefined
        ? options.body
        : typeof input.clone === "function" ? await input.clone().text() : undefined;
      if (rawBody !== undefined && rawBody !== null && rawBody !== "") {
        request.body = JSON.parse(rawBody);
      }
    } catch (error) {
      unexpectedRequests.push(`Invalid JSON request body for ${key}: ${error.message}`);
      throw error;
    }

    let body = response.body;
    if (response.delivery) {
      const delivered = await response.delivery;
      if (!delivered.ok) throw delivered.error;
      if (delivered.value !== undefined) body = delivered.value;
    }
    return responseFor(body, response.status, response.statusText);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// options.deferred accepts a deferred() handle or a promise. Resolving without
// a value releases the queued body; resolving with a value replaces that body.
// Rejecting it simulates a transport failure rather than an HTTP error.
export function enqueueResponse(method, path, body, options = {}) {
  validatePath(path);
  const key = routeKey(method, path);
  const status = options.status ?? 200;
  const statusText = options.statusText ?? statusTexts[status] ?? "";
  const pending = options.deferred;
  // Attach rejection handling immediately, even if delivery fails before fetch.
  const delivery = pending == null ? null : Promise.resolve(pending.promise ?? pending).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
  if (!responses.has(key)) responses.set(key, []);
  responses.get(key).push({ body, status, statusText, delivery });
}

export function requestsFor(method, path) {
  const key = routeKey(method, path);
  return requests.filter((request) => routeKey(request.method, request.path) === key);
}

export function assertNoUnexpectedRequests() {
  if (unexpectedRequests.length > 0) {
    throw new Error(`Unexpected API requests:\n${unexpectedRequests.join("\n")}`);
  }
}
