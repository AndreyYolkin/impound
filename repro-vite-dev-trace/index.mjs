import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import process from 'node:process'
import { ImpoundPlugin } from 'impound'
import { createServer } from 'vite'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'impound-vite-dev-trace-')))
const reports = []
let server

try {
  for (const [name, code] of Object.entries({
    'entry.js': 'import \'./a.js\'\n',
    'a.js': 'import \'./b.js\'\n',
    'b.js': 'import \'./secret.js\'\n',
    'secret.js': 'export const secret = true\n',
  })) {
    writeFileSync(join(root, name), code)
  }

  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [ImpoundPlugin.vite({
      cwd: root,
      trace: true,
      error: false,
      warn: 'always',
      patterns: [[/secret/, 'Server-only']],
      onViolation: report => reports.push(report),
    })],
  })

  for (const url of ['/entry.js', '/a.js', '/b.js']) {
    await server.environments.client.transformRequest(url)
  }

  const chain = reports[0]?.trace?.map(step => relative(root, step.file))
  process.stdout.write(`Reports while dev server is running: ${reports.length}\n`)
  process.stdout.write(`Import chain: ${chain?.join(' -> ') ?? '(missing)'}\n`)
  if (reports.length !== 1 || chain?.join(' -> ') !== 'entry.js -> a.js -> b.js') {
    process.exitCode = 1
  }
}
finally {
  await server?.close()
  rmSync(root, { recursive: true, force: true })
}
