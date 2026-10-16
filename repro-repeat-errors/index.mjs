import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { ImpoundPlugin } from 'impound'
import { createServer } from 'vite'

const root = mkdtempSync(join(tmpdir(), 'impound-vite-retry-'))
const entry = join(root, 'entry.js')
writeFileSync(entry, 'import value from "./secret.js"; console.log(value)')
writeFileSync(join(root, 'secret.js'), 'export default "TOP_SECRET"')

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'silent',
  server: { middlewareMode: true, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [ImpoundPlugin.vite({ cwd: root, patterns: [[/secret/, 'Server-only import']] })],
})

async function load() {
  try {
    await server.environments.client.transformRequest('/entry.js')
    return 'allowed'
  }
  catch (error) {
    if (!String(error.message).includes('Server-only import'))
      throw error
    return 'blocked'
  }
}

try {
  const first = await load()

  // Simulate an edit and the invalidation Vite performs before serving the module again.
  writeFileSync(entry, 'import value from "./secret.js"; console.log(value, "edited")')
  server.environments.client.moduleGraph.invalidateAll()
  const second = await load()

  process.stdout.write(`Vite dev requests: ${first}, ${second} (expected: blocked, blocked)\n`)
  if (first !== 'blocked' || second !== 'blocked')
    process.exitCode = 1
}
finally {
  await server.close()
  rmSync(root, { recursive: true, force: true })
}
