import type { Plugin, ViteDevServer } from 'vite'
import type { ImpoundOptions, ImpoundViolationInfo } from '../src'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'pathe'
import { createServer } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImpoundPlugin } from '../src'

// Record which modules reach the lexer: a dev server should only parse a violation's chain.
const parsed: string[] = []
vi.mock('es-module-lexer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('es-module-lexer')>()
  return {
    ...actual,
    parse: (code: string, id?: string) => {
      parsed.push(id ?? '?')
      return actual.parse(code, id)
    },
  }
})

let server: ViteDevServer | undefined
let root: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = undefined
  }
})

async function devServer(files: Record<string, string>, options: Partial<ImpoundOptions> = {}, plugins: Plugin[] = []) {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'impound-dev-')))
  for (const [file, code] of Object.entries(files)) {
    writeFileSync(join(root, file), code)
  }
  const violations: ImpoundViolationInfo[] = []
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      ...plugins,
      ImpoundPlugin.vite({
        cwd: root,
        trace: true,
        error: false,
        warn: 'always',
        patterns: [[/secret/, 'Server-only']],
        onViolation: (info) => {
          violations.push(info)
        },
        ...options,
      } as ImpoundOptions),
    ],
  })
  const env = server.environments.client
  const dir = root
  parsed.length = 0
  return {
    violations,
    /** Resolve an import as another plugin or the dependency scanner would, outside a transform. */
    resolve: (specifier: string, importer: string) => env.pluginContainer.resolveId(specifier, join(dir, importer)),
    /** Request modules in the order a browser would. */
    load: async (...urls: string[]) => {
      for (const url of urls) {
        await env.transformRequest(url)
      }
    },
    /** Rewrite a file and invalidate it, as the watcher would. */
    edit: (file: string, code: string) => {
      writeFileSync(join(dir, file), code)
      for (const mod of env.moduleGraph.getModulesByFile(join(dir, file)) || []) {
        env.moduleGraph.invalidateModule(mod)
      }
    },
  }
}

// Steps carry the ids Vite gave the modules, which are absolute.
const chain = (info: ImpoundViolationInfo | undefined) => info?.trace?.map(step => relative(root!, step.file))

describe('trace mode on a vite dev server', () => {
  it('reports the chain from the requested entry', async () => {
    const { violations, load } = await devServer({
      'e.js': 'import \'./a.js\'\n',
      'a.js': 'import \'./b.js\'\n',
      'b.js': 'import \'./secret.js\'\nexport const b = 1\n',
      'secret.js': 'export const s = 1\n',
    })
    await load('/e.js', '/a.js', '/b.js')

    expect(violations).toHaveLength(1)
    expect(chain(violations[0])).toEqual(['e.js', 'a.js', 'b.js'])
    expect(violations[0]!.message).toContain('1. e.js:1:8 (entry) (import "./a.js")')
    expect(violations[0]!.snippet?.text).toContain('> 1 | import \'./secret.js\'')
  })

  it('follows the chain after an import moves between modules', async () => {
    const { violations, load, edit } = await devServer({
      'e.js': 'import \'./a.js\'\nimport \'./b.js\'\n',
      'a.js': 'export const a = 1\n',
      'b.js': 'import \'./secret.js\'\nexport const b = 1\n',
      'secret.js': 'export const s = 1\n',
    })
    await load('/e.js', '/a.js', '/b.js')
    expect(chain(violations[0])).toEqual(['e.js', 'b.js'])

    edit('e.js', 'import \'./a.js\'\n')
    edit('a.js', 'import \'./b.js\'\nexport const a = 1\n')
    await load('/e.js', '/a.js')
    edit('b.js', 'import \'./secret.js\'\nexport const b = 2\n')
    await load('/b.js')

    expect(chain(violations.at(-1))).toEqual(['e.js', 'a.js', 'b.js'])
  })

  it('maps the snippet back to the original source', async () => {
    const banner: Plugin = {
      name: 'banner',
      enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('/b.js')) {
          return
        }
        // Two lines prepended, so line 1 of the original is line 3 of the output.
        return {
          code: `// banner\n// banner\n${code}`,
          map: { version: 3, sources: [id], sourcesContent: [code], names: [], mappings: ';;AAAA,OAAO;AACP' },
        }
      },
    }
    const { violations, load } = await devServer({
      'e.js': 'import \'./b.js\'\n',
      'b.js': 'import \'./secret.js\'\nexport const b = 1\n',
      'secret.js': 'export const s = 1\n',
    }, {}, [banner])
    await load('/e.js', '/b.js')

    expect(violations[0]!.snippet).toMatchObject({ line: 1, column: 7 })
    expect(violations[0]!.snippet?.text).toContain('> 1 | import \'./secret.js\'')
    expect(violations[0]!.snippet?.text).not.toContain('banner')
  })

  it('fails the request with the chain when error is enabled', async () => {
    const { load } = await devServer({
      'e.js': 'import \'./a.js\'\n',
      'a.js': 'import \'./b.js\'\n',
      'b.js': 'import \'./secret.js\'\n',
      'secret.js': 'export const s = 1\n',
    }, { error: true, onViolation: undefined })
    await load('/e.js', '/a.js')

    const error = await load('/b.js').then(() => undefined, (e: Error) => e)
    expect(error?.message).toContain('Server-only [importing `secret.js` from `b.js`]')
    expect(error?.message).toContain('1. e.js')
    expect(error?.message).toContain('3. b.js')
  })

  it('lexes only the chain of a violation', async () => {
    const { violations, load } = await devServer({
      'e.js': 'import \'./a.js\'\nimport \'./c.js\'\n',
      'a.js': 'import \'./b.js\'\n',
      'b.js': 'import \'./secret.js\'\n',
      'c.js': 'export const c = 1\n',
      'secret.js': 'export const s = 1\n',
    })
    await load('/e.js', '/c.js')
    expect(parsed).toEqual([])

    await load('/a.js', '/b.js')
    expect(violations).toHaveLength(1)
    expect(parsed.map(id => relative(root!, id)).sort()).toEqual(['a.js', 'b.js', 'e.js'])
  })

  it('holds a violation resolved before its importer is transformed', async () => {
    const { violations, load, resolve } = await devServer({
      'e.js': 'import \'./a.js\'\n',
      'a.js': 'import \'./b.js\'\n',
      'b.js': 'import \'./secret.js\'\n',
      'secret.js': 'export const s = 1\n',
    })
    await load('/e.js', '/a.js')
    await resolve('./secret.js', 'b.js')
    expect(violations).toHaveLength(0)

    await load('/b.js')
    expect(chain(violations[0])).toEqual(['e.js', 'a.js', 'b.js'])
    expect(violations[0]!.snippet?.text).toContain('> 1 | import \'./secret.js\'')
  })

  it('reports the chain without a snippet when a later plugin adds the import', async () => {
    const inject: Plugin = {
      name: 'inject',
      enforce: 'post',
      transform(code, id) {
        return id.endsWith('/b.js') ? `import './secret.js'\n${code}` : undefined
      },
    }
    const { violations, load } = await devServer({
      'e.js': 'import \'./b.js\'\n',
      'b.js': 'export const b = 1\n',
      'secret.js': 'export const s = 1\n',
    }, {}, [inject])
    await load('/e.js', '/b.js')

    expect(chain(violations[0])).toEqual(['e.js', 'b.js'])
    expect(violations[0]!.snippet).toBeUndefined()
  })
})

// Resolve `@/name` to `name.js` under the root, as a Nuxt or Vite alias would.
const alias: Plugin = { name: 'alias', resolveId: id => id.startsWith('@/') ? join(root!, `${id.slice(2)}.js`) : undefined }

const position = (info: ImpoundViolationInfo | undefined) => info?.trace?.map(step => step.line == null ? relative(root!, step.file) : `${relative(root!, step.file)}:${step.line}:${step.column}`)

describe('trace positions through aliases and extensionless imports', () => {
  const files = {
    // the aliased import is not the first, and is imported twice
    'e.js': 'import \'./c.js\'\nimport \'@/a\'\nimport(\'@/a\')\n',
    'c.js': 'export const c = 1\n',
    'a.js': '\nimport \'./b\'\n',
    'b.js': 'import \'./secret.js\'\nexport const b = 1\n',
    'secret.js': 'export const s = 1\n',
  }

  it('names the line of an extensionless import', async () => {
    const { violations, load } = await devServer(files, {}, [alias])
    await load('/e.js', '/a.js', '/b.js')

    // An alias leaves plain JS with no sourcemap to find its import through.
    expect(position(violations[0])).toEqual(['e.js', 'a.js:2:8', 'b.js'])
  })

  it('finds an aliased import in the served code an update left above its boundary', async () => {
    // SSR, whose sourcemap gives the aliased import in e.js its position
    const { violations } = await devServer(files, {}, [alias])
    const ssr = server!.environments.ssr
    for (const url of ['/e.js', '/a.js', '/b.js']) {
      await ssr.transformRequest(url)
    }

    // Invalidating a module invalidates every importer up to the entry, but only the module
    // is requested again, so e.js keeps its served code only in its invalidation state.
    for (const mod of ssr.moduleGraph.getModulesByFile(join(root!, 'b.js')) || []) {
      ssr.moduleGraph.invalidateModule(mod)
    }
    await ssr.transformRequest('/b.js')

    expect(violations).toHaveLength(2)
    expect(position(violations[1])).toEqual(['e.js:2:0', 'a.js:2:8', 'b.js'])
  })

  it('gives no position for an importer that was itself changed', async () => {
    const { violations } = await devServer(files, {}, [alias])
    const ssr = server!.environments.ssr
    for (const url of ['/e.js', '/a.js', '/b.js']) {
      await ssr.transformRequest(url)
    }

    // A changed module is invalidated hard, so no served code is kept for it.
    for (const file of ['e.js', 'b.js']) {
      for (const mod of ssr.moduleGraph.getModulesByFile(join(root!, file)) || []) {
        ssr.moduleGraph.invalidateModule(mod)
      }
    }
    await ssr.transformRequest('/b.js')

    expect(position(violations[1])).toEqual(['e.js', 'a.js:2:8', 'b.js'])
  })

  it('gives no position where the sourcemap does not cover the import', async () => {
    // a map for the first line only, while the aliased import is on the second
    const partial: Plugin = { name: 'partial', transform: (code, id) => id.endsWith('/e.js') ? { code, map: { version: 3, sources: [id], names: [], mappings: 'AAAA' } } : undefined }
    const { violations, load } = await devServer(files, {}, [alias, partial])
    await load('/e.js', '/a.js', '/b.js')

    expect(position(violations[0])).toEqual(['e.js', 'a.js:2:8', 'b.js'])
  })

  it('finds an aliased import in the code the module runner is served', async () => {
    const { violations } = await devServer(files, {}, [alias])
    const ssr = server!.environments.ssr
    for (const url of ['/e.js', '/a.js', '/b.js']) {
      await ssr.transformRequest(url)
    }

    // The SSR sourcemap maps the runner call to the start of the import statement.
    expect(position(violations[0])).toEqual(['e.js:2:0', 'a.js:2:8', 'b.js'])
  })
})

describe('structured errors', () => {
  const files = {
    'e.js': 'import \'./a.js\'\n',
    'a.js': '\nimport \'./b.js\'\n',
    'b.js': 'import \'./secret.js\'\nexport const b = 1\n',
    'secret.js': 'export const s = 1\n',
  }
  // `warn` left at its default, as a framework raising errors in the browser leaves it
  const options: Partial<ImpoundOptions> = { error: true, warn: undefined, onViolation: undefined, patterns: [[/secret/, 'Server-only', ['Import it on the server']]] }

  it('keeps the message to the violation and hands the rest over as fields', async () => {
    const { load } = await devServer(files, { ...options, structuredErrors: true })
    await load('/e.js', '/a.js')

    const error = await load('/b.js').then(() => undefined, (e: Record<string, unknown>) => e)
    expect(error).toMatchObject({
      name: 'ImpoundError',
      message: 'Server-only [importing `secret.js` from `b.js`]',
      stack: 'ImpoundError: Server-only [importing `secret.js` from `b.js`]',
      fix: 'Import it on the server',
      // innermost first, as a stack lists its frames
      sources: ['b.js:1:9', 'a.js:2:9', 'e.js:1:9'],
      id: join(root!, 'b.js'),
      plugin: 'impound',
    })
    expect(error?.trace).toHaveLength(3)
    expect(error?.snippet).toMatchObject({ line: 1, column: 8 })
    // Vite would otherwise point the error at the import in its generated code.
    expect(error?.loc).toBeUndefined()
    expect(error?.frame).toBeUndefined()
  })

  it('lists a step it has no position for by its file', async () => {
    const { load } = await devServer({ ...files, 'e.js': 'import \'@/a\'\n' }, { ...options, structuredErrors: true }, [alias])
    await load('/e.js', '/a.js')

    const error = await load('/b.js').then(() => undefined, (e: Record<string, unknown>) => e)
    expect(error?.sources).toEqual(['b.js:1:9', 'a.js:2:9', 'e.js'])
  })

  it('leaves virtual modules out of the sources', async () => {
    const virtual: Plugin = {
      name: 'virtual',
      resolveId: id => id === 'virtual:entry' ? '\0virtual:entry' : undefined,
      load: id => id === '\0virtual:entry' ? 'import \'/a.js\'\n' : undefined,
    }
    const { load } = await devServer(files, { ...options, structuredErrors: true }, [virtual])
    await load('virtual:entry', '/a.js')

    const error = await load('/b.js').then(() => undefined, (e: Record<string, unknown>) => e)
    expect((error?.trace as { file: string }[]).map(step => step.file)[0]).toBe('\0virtual:entry')
    expect(error?.sources).toEqual(['b.js:1:9', 'a.js:2:9'])
  })

  it('leaves the importing module out of sources when it is virtual', async () => {
    const virtual: Plugin = {
      name: 'virtual',
      resolveId: id => id === 'virtual:entry' ? '\0virtual:entry' : undefined,
      load: id => id === '\0virtual:entry' ? 'import \'/secret.js\'\n' : undefined,
    }
    const { load } = await devServer(files, { ...options, structuredErrors: true }, [virtual])

    const error = await load('virtual:entry').then(() => undefined, (e: Record<string, unknown>) => e)
    expect(error?.sources).toEqual([])
  })

  it('keeps the full message without the option', async () => {
    const { load } = await devServer(files, options)
    await load('/e.js', '/a.js')

    const error = await load('/b.js').then(() => undefined, (e: Record<string, unknown>) => e)
    expect(error?.message).toContain('Trace:\n  1. e.js:1:8 (entry) (import "./a.js")')
    expect(error?.message).toContain('Suggestions:\n  - Import it on the server')
    expect(error?.sources).toBeUndefined()
  })
})
