import process from 'node:process'
import { ImpoundPlugin } from 'impound'
import { rollup } from 'rollup'

const impound = ImpoundPlugin.rollup({ patterns: [['secret', 'Server-only import']] })

async function build() {
  let bundle
  try {
    bundle = await rollup({
      input: 'entry.js',
      plugins: [
        impound,
        {
          name: 'repro-modules',
          resolveId(id) {
            if (id === 'entry.js' || id === 'secret')
              return id
          },
          load(id) {
            if (id === 'entry.js')
              return 'import value from "secret"; console.log(value)'
            if (id === 'secret')
              return 'export default "TOP_SECRET"'
          },
        },
      ],
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

const first = await build()
const second = await build()
process.stdout.write(`Repeated denied import: ${first}, ${second} (expected: blocked, blocked)\n`)

if (first !== 'blocked' || second !== 'blocked') {
  process.exitCode = 1
}
