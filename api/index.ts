import { Elysia } from 'elysia';
import { node } from '@elysiajs/node';
import { cors } from '@elysiajs/cors';

const port = 3000;

new Elysia({ adapter: node() })
  .use(cors())
  .get('/api/hello', () => '<p>Hello from Elysia!</p>')
  .listen(port);

console.log(`Elysia server running at http://localhost:${port}`);
