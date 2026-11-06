import { defineConfig } from 'vite';

export default defineConfig({
    publicDir: false,
    build: {
        outDir: 'dist/npm',
        emptyOutDir: true,
        sourcemap: true,
        target: 'es2022',
        lib: {
            entry: { index: 'src/index.ts', ui: 'src/ui.ts' },
            formats: ['es'],
        },
    },
});
