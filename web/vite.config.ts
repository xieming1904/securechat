import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { computeDir, MANIFEST } from '../ops/fingerprint.mjs';
import crypto from 'node:crypto';

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// In development the Fastify server runs on :3000; Vite proxies API + websocket to it.
export default defineConfig({
  plugins: [
    react(),
    {
      // v0.8: code fingerprint over everything in dist (see ops/fingerprint.mjs)
      name: 'code-fingerprint',
      apply: 'build',
      closeBundle() {
        const dir = path.resolve(__dirname, 'dist');
        const { entries, fingerprint } = computeDir(dir);
        fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ version, fingerprint, files: entries.map(([f, h]: [string, string]) => ({ f, h })) }));
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    // v0.9: the release public key (raw Ed25519, base64url) the page checks the code-fingerprint signature with
    __RELEASE_PUBKEY__: JSON.stringify(crypto.createPublicKey(fs.readFileSync(new URL('../ops/release.pub', import.meta.url), 'utf8')).export({ format: 'jwk' }).x),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/__gate.js': 'http://localhost:3000',
      '/__gate.css': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // stable vendor chunks: an app update doesn't make everyone re-download the crypto library and React
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('libsodium')) return 'sodium';
          if (id.includes('lucide-react')) return 'icons';
          if (/[\\/](react|react-dom|scheduler|zustand|socket\.io-client|engine\.io-client|@socket\.io)[\\/]/.test(id)) return 'vendor';
          return undefined;
        },
      },
    },
  },
});
