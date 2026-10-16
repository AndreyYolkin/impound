import process from 'node:process'
import { ImpoundPlugin } from 'impound'
import { rolldown } from 'rolldown'
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

async function build(framework, contents) {
  let bundle
  try {
    const bundleWith = framework === 'rollup' ? rollup : rolldown
    const impound = ImpoundPlugin[framework]({ patterns: [['secret', 'Server-only import']] })
    bundle = await bundleWith({
      input: 'entry.js',
      plugins: [impound, modules(contents)],
    })
    await bundle.generate({ format: framework === 'rollup' ? 'es' : 'esm' })
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

const contents = {
  'entry.js': 'import value from "virtual:entry"; console.log(value)',
  '\0virtual:entry': 'import value from "secret"; export default value',
  'secret': 'export default "TOP_SECRET"',
}

for (const framework of ['rollup', 'rolldown']) {
  const result = await build(framework, contents)
  process.stdout.write(`${framework}: ${result} (expected: blocked)\n`)
  if (result !== 'blocked')
    process.exitCode = 1
}
