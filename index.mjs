import process from 'node:process'
import { ImpoundPlugin } from 'impound'
import { rollup } from 'rollup'

function modules(contents) {
  return {
    name: 'repro-modules',
    resolveId(id) {
      if (id === 'virtual:entry')
        return '\0virtual:entry'
      if (id in contents)
        return id
    },
    load(id) {
      return contents[id]
    },
  }
}

async function build(impound, contents) {
  let bundle
  try {
    bundle = await rollup({
      input: 'entry.js',
      plugins: [impound, modules(contents)],
    })
    await bundle.generate({ format: 'es' })
    return 'allowed'
  }
  catch (error) {
    if (!String(error.message).includes('Server-only import'))
      throw error
    return 'blocked'
  }
  finally {
    await bundle?.close()
  }
}

const virtual = await build(
  ImpoundPlugin.rollup({ patterns: [['secret', 'Server-only import']] }),
  {
    'entry.js': 'import value from "virtual:entry"; console.log(value)',
    '\0virtual:entry': 'import value from "secret"; export default value',
    'secret': 'export default "TOP_SECRET"',
  },
)
process.stdout.write(`Import from virtual module: ${virtual} (expected: blocked)\n`)

if (virtual !== 'blocked') {
  process.exitCode = 1
}
