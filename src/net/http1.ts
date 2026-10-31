/**
 * Minimal HTTP/1.1 client over an already-established stream. We deliberately do not use fetch():
 * Deno's fetch honours HTTP(S)_PROXY environment variables, which could silently route a request
 * somewhere the user never configured. Every byte this tool sends goes through a connection we
 * opened ourselves, either via SOCKS (Tor) or directly to a host the policy allowed.
 */

export interface RawResponse {
  status: number;
  headers: Map<string, string>;
  body: Uint8Array;
}

export class HttpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpProtocolError";
  }
}

export interface Http1Request {
  method: "GET" | "POST";
  host: string;
  port: number;
  defaultPort: number;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) offset += await conn.write(data.subarray(offset));
}

export async function readToEnd(conn: Deno.Conn, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const buffer = new Uint8Array(64 * 1024);
  while (true) {
    let n: number | null;
    try {
      n = await conn.read(buffer);
    } catch (error) {
      // Some TLS servers close without close_notify; treat as EOF only if we have data.
      if (total > 0 && error instanceof Deno.errors.UnexpectedEof) break;
      throw error;
    }
    if (n === null) break;
    total += n;
    if (total > maxBytes) throw new HttpProtocolError(`Response exceeded ${maxBytes} bytes`);
    chunks.push(buffer.slice(0, n));
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function indexOfSequence(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const CRLF = encoder.encode("\r\n");
const CRLFCRLF = encoder.encode("\r\n\r\n");

function decodeChunked(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let offset = 0;
  while (true) {
    const lineEnd = indexOfSequence(data, CRLF, offset);
    if (lineEnd < 0) throw new HttpProtocolError("Truncated chunked body");
    const sizeText = decoder.decode(data.subarray(offset, lineEnd)).split(";")[0].trim();
    if (!/^[0-9a-fA-F]+$/u.test(sizeText)) throw new HttpProtocolError("Bad chunk size");
    const size = parseInt(sizeText, 16);
    offset = lineEnd + 2;
    if (size === 0) break;
    if (offset + size + 2 > data.length) throw new HttpProtocolError("Truncated chunk");
    parts.push(data.subarray(offset, offset + size));
    offset += size + 2;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function parseResponse(raw: Uint8Array): RawResponse {
  const headerEnd = indexOfSequence(raw, CRLFCRLF);
  if (headerEnd < 0) throw new HttpProtocolError("Response has no header terminator");
  const headerText = decoder.decode(raw.subarray(0, headerEnd));
  const [statusLine, ...lines] = headerText.split("\r\n");
  const match = /^HTTP\/1\.[01] (\d{3})/u.exec(statusLine);
  if (!match) throw new HttpProtocolError(`Bad status line: ${statusLine.slice(0, 80)}`);
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  let body = raw.subarray(headerEnd + 4);
  if ((headers.get("transfer-encoding") ?? "").toLowerCase().includes("chunked")) {
    body = decodeChunked(body);
  } else if (headers.has("content-length")) {
    const length = Number(headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new HttpProtocolError("Bad Content-Length");
    }
    if (body.length < length) throw new HttpProtocolError("Truncated response body");
    body = body.subarray(0, length);
  }
  return { status: Number(match[1]), headers, body: Uint8Array.from(body) };
}

export function serializeRequest(request: Http1Request): Uint8Array {
  const hostHeader = request.port === request.defaultPort
    ? request.host
    : `${request.host}:${request.port}`;
  const headers: Record<string, string> = {
    Host: hostHeader,
    // A generic, constant User-Agent: don't fingerprint this tool or its version.
    "User-Agent": "Mozilla/5.0",
    Accept: "*/*",
    Connection: "close",
    ...request.headers,
  };
  if (request.body) headers["Content-Length"] = String(request.body.length);
  for (const [key, value] of Object.entries(headers)) {
    if (/[\r\n]/u.test(key) || /[\r\n]/u.test(value)) {
      throw new HttpProtocolError("Header contains a line break");
    }
  }
  if (/[\s]/u.test(request.path)) throw new HttpProtocolError("Request path contains whitespace");
  const head = `${request.method} ${request.path} HTTP/1.1\r\n` +
    Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n";
  const headBytes = encoder.encode(head);
  if (!request.body) return headBytes;
  const out = new Uint8Array(headBytes.length + request.body.length);
  out.set(headBytes);
  out.set(request.body, headBytes.length);
  return out;
}

export async function http1Exchange(
  conn: Deno.Conn,
  request: Http1Request,
  maxBytes: number,
): Promise<RawResponse> {
  await writeAll(conn, serializeRequest(request));
  return parseResponse(await readToEnd(conn, maxBytes));
}
