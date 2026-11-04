import type { Plugin, ViteDevServer } from 'vite'
import type { ImpoundOptions, ImpoundViolationInfo } from '../src'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'pathe'
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

async function devServer(files: Record<string, string>, options: Partial<ImpoundOptions> = {}, plugins: Plugin[] = [], aliases = false) {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'impound-dev-')))
  for (const [file, code] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), code)
  }
  const violations: ImpoundViolationInfo[] = []
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    resolve: aliases ? { alias: { '@': join(root, 'src'), '~': join(root, 'src') } } : undefined,
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
function positions(info: ImpoundViolationInfo | undefined) {
  return info?.trace?.map(step => step.line == null
    ? relative(root!, step.file)
    : `${relative(root!, step.file)}:${step.line}:${step.column}`)
}

describe('trace mode on a vite dev server', () => {
  it('does not retain a position from an importer changed by HMR', async () => {
    const { violations } = await devServer({
      'src/e.js': 'import "./c.js"\nimport "@/a"\nimport("@/a")\n',
      'src/c.js': 'export const c = 1\n',
      'src/a.js': '\nimport "./b"\n',
      'src/b.js': 'import "./secret.js"\n',
      'src/secret.js': 'export const secret = true\n',
    }, {}, [], true)
    const ssr = server!.environments.ssr
    for (const url of ['/src/e.js', '/src/a.js', '/src/b.js']) {
      await ssr.transformRequest(url)
    }
    expect(positions(violations[0])).toEqual(['src/e.js:3:7', 'src/a.js:2:8', 'src/b.js'])
    writeFileSync(join(root!, 'src/e.js'), 'export const changed = true\n')
    for (const mod of ssr.moduleGraph.getModulesByFile(join(root!, 'src/e.js')) || []) {
      ssr.moduleGraph.invalidateModule(mod)
    }
    for (const mod of ssr.moduleGraph.getModulesByFile(join(root!, 'src/b.js')) || []) {
      ssr.moduleGraph.invalidateModule(mod)
    }
    await ssr.transformRequest('/src/b.js')

    expect(violations).toHaveLength(2)
    expect(positions(violations[1])).toEqual(['src/e.js', 'src/a.js:2:8', 'src/b.js'])
  })

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

  it('keeps a chain after an entry becomes part of an import cycle', async () => {
    const { violations, load, edit } = await devServer({
      'main.js': 'import \'./router.js\'\nexport const app = {}\n',
      'router.js': 'import \'./page.js\'\n',
      'page.js': 'import { app } from \'./main.js\'\nimport \'./secret.js\'\n',
      'secret.js': 'export const s = 1\n',
    })
    await load('/main.js', '/router.js', '/page.js')
    expect(chain(violations[0])).toEqual(['main.js', 'router.js', 'page.js'])

    edit('page.js', 'import { app } from \'./main.js\'\nimport \'./secret.js\'\n')
    await load('/page.js')
    expect(chain(violations.at(-1))).toEqual(['main.js', 'router.js', 'page.js'])
    expect(violations.at(-1)?.message).not.toContain('(entry)')
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

  it('uses the map before a later plugin changes the code', async () => {
    const shift: Plugin = {
      name: 'shift',
      enforce: 'post',
      transform(code, id) {
        if (!id.endsWith('/b.js')) {
          return
        }
        return {
          code: `// added\n// added\n${code}`,
          map: { version: 3, sources: [id], sourcesContent: [code], names: [], mappings: ';;AAAA;AACA;AACA' },
        }
      },
    }
    const { violations, load } = await devServer({
      'e.js': 'import \'./b.js\'\n',
      'b.js': 'export const x = 1\nexport const y = 2\nimport \'./secret.js\'\n',
      'secret.js': 'export const s = 1\n',
    }, {}, [shift])
    await load('/e.js', '/b.js')

    expect(violations[0]!.snippet?.line).toBe(3)
    expect(violations[0]!.snippet?.text).toContain('> 3 | import \'./secret.js\'')
  })

  it('walks through modules excluded by the matcher', async () => {
    const { violations, load } = await devServer({
      'e.js': 'import \'./a.js\'\n',
      'a.js': 'import \'./b.js\'\n',
      'b.js': 'import \'./secret.js\'\n',
      'secret.js': 'export const s = 1\n',
    }, { include: [/b\.js$/] })
    await load('/e.js', '/a.js', '/b.js')

    expect(chain(violations[0])).toEqual(['e.js', 'a.js', 'b.js'])
    expect(violations[0]!.snippet?.line).toBe(1)
  })

  it('locates alias and virtual imports in a dev chain', async () => {
    const virtual: Plugin = {
      name: 'virtual-middle',
      resolveId(id) {
        if (id === 'virtual:middle') {
          return '\0virtual:middle'
        }
      },
      load(id) {
        if (id === '\0virtual:middle') {
          return 'import \'/src/a.ts\'\n'
        }
      },
    }
    const { violations, load } = await devServer({
      'src/e.ts': 'import \'virtual:middle\'\n',
      'src/a.ts': 'import \'./helper.ts\'\nimport { b } from \'@/b\'\nexport const a = b\n',
      'src/b.ts': 'export const b = 1\nimport \'./helper.ts\'\nimport \'@/other/secret\'\nimport { s } from \'~/secret\'\nexport const x = s\n',
      'src/helper.ts': 'export const helper = 1\n',
      'src/other/secret.ts': 'export const other = 1\n',
      'src/secret.ts': 'export const s = 1\n',
    }, { patterns: [[/^src\/secret$/, 'Server-only']] }, [virtual], true)
    await load('/src/e.ts', 'virtual:middle', '/src/a.ts', '/src/b.ts')

    expect(violations).toHaveLength(1)
    expect(violations[0]!.trace).toMatchObject([
      { file: join(root!, 'src/e.ts'), import: 'virtual:middle', line: 1 },
      { file: '\0virtual:middle', import: '/src/a.ts', line: 1 },
      { file: join(root!, 'src/a.ts'), import: '@/b', line: 2 },
      { file: join(root!, 'src/b.ts') },
    ])
    expect(violations[0]!.message).toContain('virtual:middle')
    expect(violations[0]!.message).not.toContain('\0')
    expect(violations[0]!.snippet?.text).toContain('> 4 | import { s } from \'~/secret\'')
  })

  it('omits a snippet when two aliases could match the same denied target', async () => {
    const { violations, load } = await devServer({
      'src/e.ts': 'import \'./b.ts\'\n',
      'src/b.ts': 'import \'~/secret\'\nimport \'@/secret\'\n',
      'src/secret.ts': 'export const s = 1\n',
    }, {}, [], true)
    await load('/src/e.ts', '/src/b.ts')

    expect(violations).toHaveLength(2)
    expect(violations.every(info => info.snippet === undefined)).toBe(true)
  })

  it('does not assign an alias position when a later plugin adds an import', async () => {
    const inject: Plugin = {
      name: 'inject',
      enforce: 'post',
      transform(code, id) {
        return id.endsWith('/a.ts') ? `${code}import './helper.ts'\n` : undefined
      },
    }
    const { violations, load } = await devServer({
      'src/e.ts': 'import \'./a.ts\'\n',
      'src/a.ts': 'import \'@/b\'\n',
      'src/b.ts': 'import \'./secret.ts\'\n',
      'src/helper.ts': 'export const helper = 1\n',
      'src/secret.ts': 'export const s = 1\n',
    }, {}, [inject], true)
    await load('/src/e.ts', '/src/a.ts', '/src/b.ts')

    expect(violations[0]!.trace?.map(step => relative(root!, step.file))).toEqual(['src/e.ts', 'src/a.ts', 'src/b.ts'])
    expect(violations[0]!.trace?.[1]).toEqual({ file: join(root!, 'src/a.ts') })
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

  it('reports a bundledDev violation before the server closes', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'impound-bundled-')))
    writeFileSync(join(root, 'index.html'), '<script type="module" src="/e.js"></script>\n')
    writeFileSync(join(root, 'e.js'), 'import \'./b.js\'\n')
    writeFileSync(join(root, 'b.js'), 'import \'./secret.js\'\n')
    writeFileSync(join(root, 'secret.js'), 'export const s = 1\n')
    const violations: ImpoundViolationInfo[] = []
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      experimental: { bundledDev: true },
      server: { port: 0, ws: false, watch: null },
      plugins: [ImpoundPlugin.vite({
        cwd: root,
        trace: true,
        error: false,
        patterns: [[/secret/, 'Server-only']],
        onViolation: (info) => { violations.push(info) },
      })],
    })
    await server.listen()
    await fetch(server.resolvedUrls!.local[0]!, { headers: { 'sec-fetch-dest': 'document' } })
    await vi.waitFor(() => expect(violations).toHaveLength(1), { timeout: 10_000 })
    expect(chain(violations[0])).toEqual(['index.html', 'e.js', 'b.js'])
  })
})
