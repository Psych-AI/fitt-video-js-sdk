import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
    root: fileURLToPath(new URL('../..', import.meta.url)),
    publicDir: false,
    server: { host: '127.0.0.1', port: 8124, strictPort: true },
    logLevel: 'warn',
});
