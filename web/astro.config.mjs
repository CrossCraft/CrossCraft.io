// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://crosscraft.io',
  vite: {
    server: {
      proxy: {
        '/api': 'http://localhost:3000',
      },
    },
  },
});
