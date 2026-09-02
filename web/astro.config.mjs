// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://crosscraft.io',
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "font-src https://fonts.gstatic.com https://cdn.jsdelivr.net",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-src https://www.youtube.com",
        "base-uri 'self'",
        "form-action 'none'",
        "object-src 'none'",
      ],
      styleDirective: {
        resources: ["'self'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net', "'unsafe-inline'"],
      },
    },
  },
  vite: {
    server: {
      proxy: {
        '/api': 'http://localhost:3000',
      },
    },
  },
});
