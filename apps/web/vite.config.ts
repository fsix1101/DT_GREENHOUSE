import { defineConfig } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const modelsDir = path.resolve(__dirname, './src/models');
const skyBoxDir = path.resolve(__dirname, './src/sky_box');
const webRootDir = path.resolve(__dirname);

export default defineConfig({

  publicDir: path.resolve(__dirname, './public'),
  server: {
    port: 3001,
    allowedHosts: true,
    host: true,
    fs: {
      allow: [webRootDir, modelsDir, skyBoxDir]
    },
  },
  preview: {
    port: 3000,
    allowedHosts: true,
    host: true,
  }
});