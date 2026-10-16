import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { relative } from 'pathe'
import { relativeToCwd } from '../src/path.ts'

const cwd = '/workspace/project'
const iterations = 500_000
const pathsFor = base => Array.from({ length: 1024 }, (_, i) => `${base}/module-${i}.ts`)

function measure(fn, paths) {
  let checksum = 0
  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    checksum += fn(cwd, paths[i & 1023]).length
  }
  return { ms: performance.now() - start, checksum }
}

const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]

for (const [scenario, paths] of [
  ['inside cwd', pathsFor(`${cwd}/src`)],
  ['outside cwd', pathsFor('/workspace/other')],
]) {
  measure(relative, paths)
  measure(relativeToCwd, paths)
  const original = []
  const optimized = []
  for (let i = 0; i < 5; i++) {
    const pair = i % 2 === 0
      ? [measure(relative, paths), measure(relativeToCwd, paths)]
      : [measure(relativeToCwd, paths), measure(relative, paths)].reverse()
    if (pair[0].checksum !== pair[1].checksum) {
      throw new Error(`Different output for ${scenario}`)
    }
    original.push(pair[0].ms)
    optimized.push(pair[1].ms)
  }
  const beforeMs = median(original)
  const afterMs = median(optimized)
  process.stdout.write(`${scenario}: pathe.relative ${beforeMs.toFixed(1)} ms; relativeToCwd ${afterMs.toFixed(1)} ms; ${(beforeMs / afterMs).toFixed(2)}x\n`)
}
