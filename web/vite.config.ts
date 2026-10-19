import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Geliştirmede API istekleri sunucuya (3000) yönlendirilir; derlenmiş panel aynı sunucudan sunulur.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  build: { outDir: 'dist', sourcemap: false },
});
