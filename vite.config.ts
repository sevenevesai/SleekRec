import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

// The dev server needs what the packaged policy in index.html forbids: React refresh's inline
// preamble script, CSS injected as <style> tags, and the HMR WebSocket.
const devCspSources: Record<string, string> = {
  'script-src': "'unsafe-inline'",
  'style-src': "'unsafe-inline'",
  'connect-src': "'self'",
}

function devContentSecurityPolicy(html: string, ctx: { path: string }) {
  const meta = /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)/
  const policy = meta.exec(html)?.[2]
  if (policy === undefined) throw new Error(`${ctx.path} has no Content-Security-Policy meta tag`)
  const directives = policy.split(';').map(directive => directive.trim().split(/\s+/))
  for (const [name, source] of Object.entries(devCspSources)) {
    const directive = directives.find(([directiveName]) => directiveName === name)
    if (directive) directive.push(source)
    else directives.push([name, source])
  }
  return html.replace(meta, (_, start: string) => start + directives.map(d => d.join(' ')).join('; '))
}

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    // Script assets imported with ?url (the AudioWorklet) stay files: the CSP's script-src
    // allows 'self', not data: URLs.
    assetsInlineLimit: file => (file.endsWith('.js') ? false : undefined),
  },
  plugins: [
    react(),
    { name: 'dev-content-security-policy', apply: 'serve', transformIndexHtml: devContentSecurityPolicy },
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              external: ['ffmpeg-static'],
            },
          },
        },
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        input: 'electron/preload.ts',
      },
    }),
  ],
})
