import { defineConfig } from 'vite';

export default defineConfig({
    publicDir: false,
    build: {
        outDir: 'dist/hosted',
        emptyOutDir: true,
        sourcemap: true,
        target: 'es2022',
        lib: {
            entry: 'src/hosted.ts',
            name: 'FittVideo',
            formats: ['es', 'iife'],
            fileName: (format) =>
                format === 'es' ? 'fitt-video.js' : 'fitt-video.iife.js',
        },
    },
});
