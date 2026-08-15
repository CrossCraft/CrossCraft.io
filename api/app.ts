import { cors } from '@elysiajs/cors';
import { node } from '@elysiajs/node';
import { Elysia } from 'elysia';
import { isIP } from 'node:net';

const HEARTBEAT_PATH = '/api/v1/heartbeat';
const LIST_PATH = '/api/v1/list';
const HEARTBEAT_TTL_MS = 45_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_NAME_LENGTH = 64;
const ALLOWED_ORIGINS = ['https://crosscraft.io', 'https://www.crosscraft.io'];

const DEFAULT_HEARTBEAT_RATE_LIMIT = 10;
const DEFAULT_LIST_RATE_LIMIT = 60;

const DECIMAL_INTEGER = /^\d+$/;
const SALT = /^[A-Za-z0-9]{16}$/;

type RequestWithClientIp = Request & {
  ip?: string;
};

export type ClientIpResolver = (request: Request) => string | undefined;

export interface RateLimits {
  heartbeatPerMinute: number;
  listPerMinute: number;
}

export interface ApiAppOptions {
  clock?: () => number;
  clientIp?: ClientIpResolver;
  rateLimits?: Partial<RateLimits>;
}

export interface ServerListRecord {
  url: string;
  name: string;
  port: number;
  max: number;
  public: boolean;
  version: number;
  users: number;
  lastSeen: string;
}

type Heartbeat = Omit<ServerListRecord, 'url' | 'lastSeen'> & {
  salt: string;
};

type StoredServer = Heartbeat & {
  address: string;
  url: string;
  lastSeen: number;
};

type UpsertResult = 'joined' | 'updated' | 'conflict';

class BadHeartbeatError extends Error {}

class ServerRegistry {
  private readonly servers = new Map<string, StoredServer>();

  upsert(server: StoredServer, now: number): UpsertResult {
    this.prune(now);
    const key = this.key(server.address, server.port);
    const existing = this.servers.get(key);
    if (existing && existing.salt !== server.salt) return 'conflict';
    this.servers.set(key, server);
    return existing ? 'updated' : 'joined';
  }

  list(now: number): ServerListRecord[] {
    this.prune(now);

    return [...this.servers.values()]
      .filter((server) => server.public)
      .sort((left, right) => {
        const byName = left.name.localeCompare(right.name);
        return byName || left.url.localeCompare(right.url);
      })
      .map(({ url, name, port, max, public: isPublic, version, users, lastSeen }) => ({
        url,
        name,
        port,
        max,
        public: isPublic,
        version,
        users,
        lastSeen: new Date(lastSeen).toISOString(),
      }));
  }

  private prune(now: number): void {
    for (const [key, server] of this.servers) {
      if (now - server.lastSeen > HEARTBEAT_TTL_MS) this.servers.delete(key);
    }
  }

  private key(address: string, port: number): string {
    return `${address}:${port}`;
  }
}

class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Rate limits must be positive safe integers');
    }
  }

  consume(key: string, now: number): number | undefined {
    this.sweep(now);

    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    let hits = this.hits.get(key);
    if (!hits) {
      hits = [];
      this.hits.set(key, hits);
    }
    while (hits.length > 0 && hits[0] <= cutoff) hits.shift();

    if (hits.length >= this.limit) {
      return Math.max(1, Math.ceil((hits[0] + RATE_LIMIT_WINDOW_MS - now) / 1000));
    }

    hits.push(now);
    return undefined;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < RATE_LIMIT_WINDOW_MS) return;
    this.lastSweep = now;

    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    for (const [key, hits] of this.hits) {
      if (hits[hits.length - 1] <= cutoff) this.hits.delete(key);
    }
  }
}

function defaultClientIp(request: Request): string | undefined {
  return (request as RequestWithClientIp).ip;
}

function normalizeClientIp(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const address = value.trim();
  const version = isIP(address);
  if (version === 0) return undefined;

  const lowerAddress = address.toLowerCase();
  if (version === 6 && lowerAddress.startsWith('::ffff:')) {
    const mappedAddress = address.slice('::ffff:'.length);
    if (isIP(mappedAddress) === 4) return mappedAddress;
  }

  return version === 6 ? lowerAddress : address;
}

function advertisedUrl(address: string, port: number): string {
  const host = isIP(address) === 6 ? `[${address}]` : address;
  return `http://${host}:${port}/`;
}

function responseText(body: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      ...extraHeaders,
    },
  });
}

function responseJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function rateLimitedResponse(retryAfter: number): Response {
  return responseText('rate limited', 429, {
    'retry-after': String(retryAfter),
  });
}

function methodNotAllowed(allow: string): Response {
  return responseText('method not allowed', 405, { allow });
}

function directoryFailure(): Response {
  return responseText('directory service failure', 500);
}

function requiredField(params: URLSearchParams, name: string): string {
  const values = params.getAll(name);
  if (values.length !== 1) throw new BadHeartbeatError(`missing or invalid ${name}`);
  return values[0];
}

function decimalField(params: URLSearchParams, name: string, minimum: number): number {
  const raw = requiredField(params, name);
  if (!DECIMAL_INTEGER.test(raw)) throw new BadHeartbeatError(`missing or invalid ${name}`);

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new BadHeartbeatError(`missing or invalid ${name}`);
  }

  return value;
}

function parseHeartbeatFields(params: URLSearchParams): Heartbeat {
  const port = decimalField(params, 'port', 1);
  if (port > 65_535) throw new BadHeartbeatError('missing or invalid port');

  const max = decimalField(params, 'max', 0);
  const name = requiredField(params, 'name').trim();
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new BadHeartbeatError('missing or invalid name');
  }

  const publicValue = requiredField(params, 'public').toLowerCase();
  if (publicValue !== 'true' && publicValue !== 'false') {
    throw new BadHeartbeatError('missing or invalid public');
  }

  const version = decimalField(params, 'version', 0);
  const salt = requiredField(params, 'salt');
  if (!SALT.test(salt)) throw new BadHeartbeatError('missing or invalid salt');

  const users = decimalField(params, 'users', 0);
  if (users > max) throw new BadHeartbeatError('missing or invalid users');

  return {
    port,
    max,
    name,
    public: publicValue === 'true',
    version,
    salt,
    users,
  };
}

function parsePositiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!DECIMAL_INTEGER.test(value)) throw new Error(`${name} must be a positive safe integer`);

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return parsed;
}

export function readRateLimits(env: NodeJS.ProcessEnv = process.env): RateLimits {
  return {
    heartbeatPerMinute: parsePositiveInteger(
      env.HEARTBEAT_RATE_LIMIT_PER_MINUTE,
      'HEARTBEAT_RATE_LIMIT_PER_MINUTE',
      DEFAULT_HEARTBEAT_RATE_LIMIT,
    ),
    listPerMinute: parsePositiveInteger(
      env.LIST_RATE_LIMIT_PER_MINUTE,
      'LIST_RATE_LIMIT_PER_MINUTE',
      DEFAULT_LIST_RATE_LIMIT,
    ),
  };
}

export type TrustProxySetting = false | 'loopback' | string[];

export function readTrustProxy(value = process.env.TRUST_PROXY): TrustProxySetting {
  if (value === undefined || value.trim() === '' || value.trim().toLowerCase() === 'false') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'loopback') return 'loopback';
  if (normalized === 'true') {
    throw new Error('TRUST_PROXY must be loopback or a comma-separated proxy IP allowlist');
  }

  const addresses = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!addresses.length || addresses.some((address) => isIP(address) === 0)) {
    throw new Error('TRUST_PROXY must be loopback or a comma-separated proxy IP allowlist');
  }

  return [...new Set(addresses)];
}

export function readPort(value = process.env.PORT): number {
  if (value === undefined || value.trim() === '') return 3000;
  const port = parsePositiveInteger(value, 'PORT', 3000);
  if (port > 65_535) throw new Error('PORT must be a valid TCP port');
  return port;
}

export function createApp(options: ApiAppOptions = {}) {
  const clock = options.clock ?? Date.now;
  const clientIp = options.clientIp ?? defaultClientIp;
  const configuredLimits = readRateLimits();
  const limits: RateLimits = {
    heartbeatPerMinute: options.rateLimits?.heartbeatPerMinute ?? configuredLimits.heartbeatPerMinute,
    listPerMinute: options.rateLimits?.listPerMinute ?? configuredLimits.listPerMinute,
  };

  const registry = new ServerRegistry();
  const heartbeatLimiter = new SlidingWindowRateLimiter(limits.heartbeatPerMinute);
  const listLimiter = new SlidingWindowRateLimiter(limits.listPerMinute);

  const resolveAddress = (request: Request): string | undefined => normalizeClientIp(clientIp(request));

  const handleHeartbeat = (request: Request): Response => {
    const address = resolveAddress(request);
    if (!address) return directoryFailure();

    const now = clock();
    const retryAfter = heartbeatLimiter.consume(address, now);
    if (retryAfter !== undefined) return rateLimitedResponse(retryAfter);

    try {
      const heartbeat = parseHeartbeatFields(new URL(request.url).searchParams);
      const url = advertisedUrl(address, heartbeat.port);
      const result = registry.upsert({ ...heartbeat, address, url, lastSeen: now }, now);
      if (result === 'conflict') return responseText('salt mismatch', 403);
      if (result === 'joined') {
        console.log(
          `[heartbeat] server joined: ${url} name=${JSON.stringify(heartbeat.name)} `
          + `players=${heartbeat.users}/${heartbeat.max} public=${heartbeat.public}`,
        );
      }
      return responseText(url);
    } catch (error) {
      if (error instanceof BadHeartbeatError) return responseText(error.message, 400);
      return directoryFailure();
    }
  };

  const handleList = (request: Request): Response => {
    const address = resolveAddress(request);
    if (!address) return directoryFailure();

    const now = clock();
    const retryAfter = listLimiter.consume(address, now);
    if (retryAfter !== undefined) return rateLimitedResponse(retryAfter);

    try {
      return responseJson(registry.list(now));
    } catch {
      return directoryFailure();
    }
  };

  return new Elysia({ adapter: node() })
    .use(cors({ origin: ALLOWED_ORIGINS, credentials: false }))
    .all(HEARTBEAT_PATH, ({ request }) => {
      if (request.method === 'GET') return handleHeartbeat(request);
      return methodNotAllowed('GET');
    })
    .all(LIST_PATH, ({ request }) => {
      if (request.method === 'GET') return handleList(request);
      return methodNotAllowed('GET');
    })
    .get('/api/hello', () => '<p>Hello from Elysia!</p>');
}
