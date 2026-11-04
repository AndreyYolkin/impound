import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import process from 'node:process'
import { ImpoundPlugin } from 'impound'

const require = createRequire(import.meta.url)
const bundlers = [
  ['webpack', require('webpack')],
  ['rspack', require('@rspack/core').rspack],
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
  for (const [traceName, trace] of [['eager', true], ['lazy', 'lazy']]) {
    for (const [caseName, [entryCode, aCode]] of Object.entries(cases)) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), `impound-${bundlerName}-${traceName}-${caseName}-`)))
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
        const compiler = bundler({
          mode: 'development',
          target: 'node',
          context: root,
          entry: join(root, 'entry.js'),
          resolve: { alias: { '@': root } },
          output: { path: join(root, 'dist'), filename: 'bundle.js' },
          plugins: [ImpoundPlugin[bundlerName]({
            cwd: root,
            trace,
            patterns: [[/secret/, 'Denied']],
            onViolation: info => reports.push(info),
          })],
        })
        let stats
        try {
          stats = await new Promise((resolve, reject) => compiler.run((error, result) => error ? reject(error) : resolve(result)))
        }
        finally {
          await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()))
        }

        const chain = reports[0]?.trace?.map((step) => {
          const file = relative(root, step.file)
          return step.line == null ? file : `${file}:${step.line}:${step.column}`
        }).join(' -> ') ?? '(missing)'
        const denied = stats.compilation.errors.filter(error => error.message.includes('Denied')).length
        process.stdout.write(`${bundlerName} ${traceName} ${caseName}: ${chain}\n`)
        if (reports.length !== 1 || denied !== 1 || chain !== expected) {
          failed = true
        }
      }
      finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  }
}

if (failed) {
  process.exitCode = 1
}
