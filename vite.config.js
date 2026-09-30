import fs from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 証明書はローカル開発用。ない環境(CIなど)でもビルドできるようにする
const hasCert = fs.existsSync('./localhost-key.pem') && fs.existsSync('./localhost.pem')

export default defineConfig({
  plugins: [react()],
  server: {
    host: 'localhost',
    https: hasCert ? {
      key: fs.readFileSync('./localhost-key.pem'),
      cert: fs.readFileSync('./localhost.pem'),
    } : undefined,
    proxy: {
      // API は wrangler dev(Cloudflare Worker)で動かす
      '/api': { target: 'http://localhost:8787' },
    },
  },
})
