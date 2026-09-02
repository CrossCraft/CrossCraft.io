import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createApp,
  createClientIpResolver,
  readPort,
  readRateLimits,
  readTrustProxy,
  type RateLimits,
} from './app.js';

const defaultFields = {
  port: '25565',
  max: '32',
  name: 'My Server',
  public: 'True',
  version: '7',
  salt: 'wo6kVAHjxoJcInKx',
  users: '0',
};

type TestApp = ReturnType<typeof createApp>;

function fields(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({ ...defaultFields, ...overrides }).toString();
}

function setup(ip = '203.0.113.10', rateLimits?: Partial<RateLimits>) {
  let now = 0;
  const app = createApp({
    clock: () => now,
    clientIp: () => ip,
    rateLimits,
  });

  return {
    app,
    setNow: (value: number) => {
      now = value;
    },
  };
}

function request(app: TestApp, path: string, init?: RequestInit): Promise<Response> {
  return app.handle(new Request(`http://directory.test${path}`, init));
}

function getHeartbeat(app: TestApp, query = fields()): Promise<Response> {
  return request(app, `/api/v1/heartbeat?${query}`, { method: 'GET' });
}

describe('Minecraft Classic heartbeat API', () => {
  it('accepts a heartbeat and returns the observed server URL', async () => {
    const { app } = setup();

    const response = await getHeartbeat(app);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), 'http://203.0.113.10:25565/');
  });

  it('URL-decodes heartbeat fields', async () => {
    const { app } = setup();

    const response = await getHeartbeat(app, fields({ name: 'Classic + Friends' }));

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'http://203.0.113.10:25565/');
  });

  it('accepts case-insensitive public values', async () => {
    const { app } = setup();

    for (const value of ['true', 'TRUE', 'false', 'FALSE']) {
      const response = await getHeartbeat(app, fields({ public: value }));
      assert.equal(response.status, 200, value);
    }
  });

  it('returns active public records with natural JSON types and no salt', async () => {
    const { app } = setup();
    await getHeartbeat(app, fields({ users: '3' }));

    const response = await request(app, '/api/v1/list', { method: 'GET' });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=10');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(body, [{
      url: 'http://203.0.113.10:25565/',
      name: 'My Server',
      port: 25565,
      max: 32,
      public: true,
      version: 7,
      users: 3,
      lastSeen: '1970-01-01T00:00:00.000Z',
    }]);
    assert.doesNotMatch(JSON.stringify(body), /wo6kVAHjxoJcInKx/);
  });

  it('returns a successful URL for private servers but excludes them from the list', async () => {
    const { app } = setup();

    const heartbeat = await getHeartbeat(app, fields({ public: 'False' }));
    const list = await request(app, '/api/v1/list', { method: 'GET' });

    assert.equal(heartbeat.status, 200);
    assert.equal(await heartbeat.text(), 'http://203.0.113.10:25565/');
    assert.deepEqual(await list.json(), []);
  });

  it('removes records only after more than 45 seconds without a heartbeat', async () => {
    const { app, setNow } = setup();
    await getHeartbeat(app);

    setNow(45_000);
    let list = await request(app, '/api/v1/list', { method: 'GET' });
    assert.equal((await list.json()).length, 1);

    setNow(45_001);
    list = await request(app, '/api/v1/list', { method: 'GET' });
    assert.deepEqual(await list.json(), []);
  });

  it('updates a server record when the same address and port heartbeat again', async () => {
    const { app, setNow } = setup();
    await getHeartbeat(app);

    setNow(1_000);
    await getHeartbeat(app, fields({ name: 'Updated', max: '64', users: '4' }));
    const list = await request(app, '/api/v1/list', { method: 'GET' });

    assert.deepEqual(await list.json(), [{
      url: 'http://203.0.113.10:25565/',
      name: 'Updated',
      port: 25565,
      max: 64,
      public: true,
      version: 7,
      users: 4,
      lastSeen: '1970-01-01T00:00:01.000Z',
    }]);
  });

  it('formats IPv6 source addresses as absolute URLs', async () => {
    const { app } = setup('2001:DB8::1');

    const response = await getHeartbeat(app);

    assert.equal(await response.text(), 'http://[2001:db8::1]:25565/');
  });

  it('rejects a heartbeat whose salt does not match the registered server', async () => {
    const { app, setNow } = setup();

    assert.equal((await getHeartbeat(app)).status, 200);
    assert.equal((await getHeartbeat(app, fields({ salt: 'AAAAbbbbCCCCdddd' }))).status, 403);
    assert.equal((await getHeartbeat(app)).status, 200);

    // Once the record expires, a new owner may claim the address and port.
    setNow(45_001);
    assert.equal((await getHeartbeat(app, fields({ salt: 'AAAAbbbbCCCCdddd' }))).status, 200);
  });

  it('rejects invalid heartbeat fields with 400', async () => {
    const invalidCases = [
      ['port', { port: '0' }],
      ['port range', { port: '65536' }],
      ['max', { max: '-1' }],
      ['name', { name: '   ' }],
      ['name too long', { name: 'x'.repeat(65) }],
      ['public', { public: 'yes' }],
      ['version', { version: '-1' }],
      ['salt', { salt: 'too-short' }],
      ['users', { users: '33' }],
    ] as const;

    for (const [label, override] of invalidCases) {
      const { app } = setup();
      const response = await getHeartbeat(app, fields(override));
      assert.equal(response.status, 400, label);
    }
  });

  it('rejects missing and duplicate fields', async () => {
    const { app } = setup();

    let response = await getHeartbeat(app, fields({ port: '' }));
    assert.equal(response.status, 400);

    response = await getHeartbeat(app, `${fields()}&port=25566`);
    assert.equal(response.status, 400);
  });

  it('returns 405 for unsupported methods and scopes CORS to the site origin', async () => {
    const { app } = setup();

    let response = await request(app, '/api/v1/heartbeat', { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');

    response = await request(app, '/api/v1/list', { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');

    response = await request(app, '/api/v1/list', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://crosscraft.io',
        'access-control-request-method': 'GET',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      'https://crosscraft.io',
    );
    assert.equal(response.headers.get('access-control-allow-headers'), 'accept, content-type');
    assert.equal(response.headers.get('access-control-max-age'), '600');

    response = await request(app, '/api/v1/list', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.test',
        'access-control-request-method': 'GET',
      },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  it('applies independent configurable per-IP rate limits', async () => {
    const { app, setNow } = setup('203.0.113.10', {
      heartbeatPerMinute: 2,
      listPerMinute: 1,
    });

    assert.equal((await getHeartbeat(app)).status, 200);
    assert.equal((await getHeartbeat(app)).status, 200);
    let response = await getHeartbeat(app);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');

    assert.equal((await request(app, '/api/v1/list', { method: 'GET' })).status, 200);
    response = await request(app, '/api/v1/list', { method: 'GET' });
    assert.equal(response.status, 429);

    setNow(60_000);
    assert.equal((await getHeartbeat(app)).status, 200);
  });
});

describe('API configuration', () => {
  it('reads safe proxy, port, and rate-limit settings', () => {
    assert.equal(readPort(undefined), 3000);
    assert.deepEqual(readTrustProxy(undefined), false);
    assert.equal(readTrustProxy('loopback'), 'loopback');
    assert.deepEqual(readTrustProxy('127.0.0.1,::1'), ['127.0.0.1', '::1']);
    assert.deepEqual(readTrustProxy('10.11.0.0/16,10.0.1.0/24'), ['10.11.0.0/16', '10.0.1.0/24']);
    assert.deepEqual(readRateLimits({
      HEARTBEAT_RATE_LIMIT_PER_MINUTE: '4',
      LIST_RATE_LIMIT_PER_MINUTE: '9',
    }), {
      heartbeatPerMinute: 4,
      listPerMinute: 9,
    });
  });

  it('rejects unsafe or malformed proxy configuration', () => {
    assert.throws(() => readTrustProxy('true'));
    assert.throws(() => readTrustProxy('not-an-ip'));
    assert.throws(() => readTrustProxy('10.11.0.0/33'));
    assert.throws(() => readTrustProxy('::1/128'));
    assert.throws(() => readRateLimits({ HEARTBEAT_RATE_LIMIT_PER_MINUTE: '0' }));
  });
});

describe('trusted proxy resolution', () => {
  function peerRequest(ip: string | undefined, forwardedFor?: string): Request {
    const headers = forwardedFor === undefined
      ? new Headers()
      : new Headers({ 'x-forwarded-for': forwardedFor });
    return { ip, headers } as unknown as Request;
  }

  it('uses the socket address when the peer is not a trusted proxy', () => {
    const resolver = createClientIpResolver(['10.11.0.0/16']);
    assert.equal(resolver(peerRequest('192.0.2.7', '203.0.113.99')), '192.0.2.7');
    assert.equal(resolver(peerRequest('192.0.2.7')), '192.0.2.7');
  });

  it('resolves the rightmost untrusted forwarded address behind a trusted proxy', () => {
    const resolver = createClientIpResolver(['10.11.0.0/16']);
    assert.equal(resolver(peerRequest('10.11.0.7', '203.0.113.99')), '203.0.113.99');
    assert.equal(resolver(peerRequest('10.11.0.7', '192.0.2.1, 203.0.113.99')), '203.0.113.99');
  });

  it('ignores unparseable forwarded entries while walking the chain', () => {
    const resolver = createClientIpResolver(['10.11.0.0/16']);
    assert.equal(resolver(peerRequest('10.11.0.7', 'not-an-ip, 203.0.113.99')), '203.0.113.99');
  });

  it('falls back to the socket address when every forwarded entry is trusted', () => {
    const resolver = createClientIpResolver(['10.0.0.0/8']);
    assert.equal(resolver(peerRequest('10.11.0.7', '10.11.0.7, 10.11.0.8')), '10.11.0.7');
  });

  it('matches IPv4-mapped socket addresses against IPv4 CIDRs', () => {
    const resolver = createClientIpResolver(['10.11.0.0/16']);
    assert.equal(resolver(peerRequest('::ffff:10.11.0.7', '203.0.113.99')), '203.0.113.99');
  });

  it('honors loopback-only trust', () => {
    const resolver = createClientIpResolver('loopback');
    assert.equal(resolver(peerRequest('127.0.0.1', '203.0.113.99')), '203.0.113.99');
    assert.equal(resolver(peerRequest('10.11.0.7', '203.0.113.99')), '10.11.0.7');
  });

  it('honors exact IPv6 trusted proxies', () => {
    const resolver = createClientIpResolver(['2001:DB8::1']);
    assert.equal(resolver(peerRequest('2001:db8::1', '203.0.113.99')), '203.0.113.99');
  });

  it('never trusts forwarded data when trust is disabled', () => {
    const resolver = createClientIpResolver(false);
    assert.equal(resolver(peerRequest('10.11.0.7', '203.0.113.99')), '10.11.0.7');
  });
});
