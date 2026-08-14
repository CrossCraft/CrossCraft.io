import { createApp, readPort, readTrustProxy } from './app.js';

const port = readPort();
const trustProxy = readTrustProxy();

const app = createApp();
let ready: Promise<unknown> | undefined;

app.listen({
  port,
  trustProxy,
} as Parameters<typeof app.listen>[0], (server) => {
  ready = (server as unknown as {
    raw?: {
      ready?: () => Promise<unknown>;
    };
  }).raw?.ready?.();
});

try {
  await ready;
  console.log(`Elysia server running at http://localhost:${port}`);
} catch (error) {
  console.error(`Elysia failed to listen on port ${port}`, error);
  process.exitCode = 1;
}
