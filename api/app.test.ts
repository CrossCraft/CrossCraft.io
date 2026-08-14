import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createApp,
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

function postHeartbeat(app: TestApp, body = fields()): Promise<Response> {
  return request(app, '/api/v1/heartbeat', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
}

describe('Minecraft Classic heartbeat API', () => {
  it('accepts a form POST and returns the observed server URL', async () => {
    const { app } = setup();

    const response = await postHeartbeat(app);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await response.text(), 'http://203.0.113.10:25565/');
  });

  it('accepts a legacy GET heartbeat and URL-decodes fields', async () => {
    const { app } = setup();
    const query = fields({ name: 'Classic + Friends' });

    const response = await request(app, `/api/v1/heartbeat?${query}`, { method: 'GET' });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'http://203.0.113.10:25565/');
  });

  it('accepts case-insensitive public values', async () => {
    const { app } = setup();

    for (const value of ['true', 'TRUE', 'false', 'FALSE']) {
      const response = await postHeartbeat(app, fields({ public: value }));
      assert.equal(response.status, 200, value);
    }
  });

  it('returns active public records with natural JSON types and no salt', async () => {
    const { app } = setup();
    await postHeartbeat(app, fields({ users: '3' }));

    const response = await request(app, '/api/v1/list', { method: 'GET' });
    const body = await response.json();

    assert.equal(response.status, 200);
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

    const heartbeat = await postHeartbeat(app, fields({ public: 'False' }));
    const list = await request(app, '/api/v1/list', { method: 'GET' });

    assert.equal(heartbeat.status, 200);
    assert.equal(await heartbeat.text(), 'http://203.0.113.10:25565/');
    assert.deepEqual(await list.json(), []);
  });

  it('removes records only after more than 45 seconds without a heartbeat', async () => {
    const { app, setNow } = setup();
    await postHeartbeat(app);

    setNow(45_000);
    let list = await request(app, '/api/v1/list', { method: 'GET' });
    assert.equal((await list.json()).length, 1);

    setNow(45_001);
    list = await request(app, '/api/v1/list', { method: 'GET' });
    assert.deepEqual(await list.json(), []);
  });

  it('updates a server record when the same address and port heartbeat again', async () => {
    const { app, setNow } = setup();
    await postHeartbeat(app);

    setNow(1_000);
    await postHeartbeat(app, fields({ name: 'Updated', max: '64', users: '4' }));
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

    const response = await postHeartbeat(app);

    assert.equal(await response.text(), 'http://[2001:db8::1]:25565/');
  });

  it('rejects invalid heartbeat fields with 400', async () => {
    const invalidCases = [
      ['port', { port: '0' }],
      ['port range', { port: '65536' }],
      ['max', { max: '-1' }],
      ['name', { name: '   ' }],
      ['public', { public: 'yes' }],
      ['version', { version: '-1' }],
      ['salt', { salt: 'too-short' }],
      ['users', { users: '33' }],
    ] as const;

    for (const [label, override] of invalidCases) {
      const { app } = setup();
      const response = await postHeartbeat(app, fields(override));
      assert.equal(response.status, 400, label);
    }
  });

  it('rejects missing, duplicate, and wrongly encoded fields', async () => {
    const { app } = setup();

    let response = await postHeartbeat(app, fields({ port: '' }));
    assert.equal(response.status, 400);

    response = await postHeartbeat(app, `${fields()}&port=25566`);
    assert.equal(response.status, 400);

    response = await request(app, '/api/v1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(defaultFields),
    });
    assert.equal(response.status, 400);
  });

  it('returns 405 for unsupported methods and allows CORS preflight', async () => {
    const { app } = setup();

    let response = await request(app, '/api/v1/heartbeat', { method: 'PUT' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, POST');

    response = await request(app, '/api/v1/list', { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');

    response = await request(app, '/api/v1/list', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.test',
        'access-control-request-method': 'GET',
      },
    });
    assert.equal(response.status, 204);
  });

  it('applies independent configurable per-IP rate limits', async () => {
    const { app, setNow } = setup('203.0.113.10', {
      heartbeatPerMinute: 2,
      listPerMinute: 1,
    });

    assert.equal((await postHeartbeat(app)).status, 200);
    assert.equal((await postHeartbeat(app)).status, 200);
    let response = await postHeartbeat(app);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');

    assert.equal((await request(app, '/api/v1/list', { method: 'GET' })).status, 200);
    response = await request(app, '/api/v1/list', { method: 'GET' });
    assert.equal(response.status, 429);

    setNow(60_000);
    assert.equal((await postHeartbeat(app)).status, 200);
  });
});

describe('API configuration', () => {
  it('reads safe proxy, port, and rate-limit settings', () => {
    assert.equal(readPort(undefined), 3000);
    assert.deepEqual(readTrustProxy(undefined), false);
    assert.equal(readTrustProxy('loopback'), 'loopback');
    assert.deepEqual(readTrustProxy('127.0.0.1,::1'), ['127.0.0.1', '::1']);
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
    assert.throws(() => readRateLimits({ HEARTBEAT_RATE_LIMIT_PER_MINUTE: '0' }));
  });
});
