import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { rspack } from '@rspack/core'
import { build } from 'vite'
import webpack from 'webpack'

const { ImpoundPlugin } = await import(process.env.IMPOUND_ENTRY ? pathToFileURL(process.env.IMPOUND_ENTRY).href : 'impound')
const bundlers = [
  ['vite', null],
  ['webpack', webpack],
  ['rspack', rspack],
]
const cases = {
  direct: ['import "./a.js"\n', 'import "./b.js"\n'],
  extensionless: ['import "./a"\n', 'import "./b"\n'],
  alias: ['import "@/a.js"\n', 'import "@/b.js"\n'],
  mixed: ['import "@/a"\n', 'import "./b"\n'],
}
const expected = 'entry.js:1:8 -> a.js:1:8 -> b.js'
let failed = false

for (const [bundlerName, bundler] of bundlers) {
  for (const [caseName, [entryCode, aCode]] of Object.entries(cases)) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `impound-lazy-${bundlerName}-${caseName}-`)))
    try {
      for (const [file, code] of Object.entries({
        'entry.js': entryCode,
        'a.js': aCode,
        'b.js': 'import "./secret.js"\n',
        'secret.js': 'export const secret = true\n',
      })) {
        writeFileSync(join(root, file), code)
      }

      const reports = []
      let denied = 0
      const options = {
        cwd: root,
        trace: 'lazy',
        patterns: [[/secret/, 'Denied']],
        onViolation: info => reports.push(info),
      }
      if (bundlerName === 'vite') {
        const plugins = [ImpoundPlugin.vite(options)].flat().map(plugin => Object.assign(plugin, {
          enforce: plugin.name.includes('trace') ? undefined : 'pre',
        }))
        try {
          await build({
            root,
            configFile: false,
            logLevel: 'silent',
            resolve: { alias: { '@': root } },
            plugins,
            build: { outDir: join(root, 'dist'), rollupOptions: { input: join(root, 'entry.js') } },
          })
        }
        catch (error) {
          denied = String(error).includes('Denied') ? 1 : 0
        }
      }
      else {
        const compiler = bundler({
          mode: 'development',
          target: 'node',
          context: root,
          entry: join(root, 'entry.js'),
          resolve: { alias: { '@': root } },
          output: { path: join(root, 'dist'), filename: 'bundle.js' },
          plugins: [ImpoundPlugin[bundlerName](options)],
        })
        let stats
        try {
          stats = await new Promise((resolve, reject) => compiler.run((error, result) => error ? reject(error) : resolve(result)))
        }
        finally {
          await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()))
        }
        denied = stats.compilation.errors.filter(error => error.message.includes('Denied')).length
      }

      const chain = reports[0]?.trace?.map((step) => {
        const file = relative(root, step.file)
        return step.line == null ? file : `${file}:${step.line}:${step.column}`
      }).join(' -> ') ?? '(missing)'
      process.stdout.write(`${bundlerName} ${caseName}: ${chain}\n`)
      if (reports.length !== 1 || denied !== 1 || chain !== expected) {
        failed = true
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

if (failed) {
  process.exitCode = 1
}
