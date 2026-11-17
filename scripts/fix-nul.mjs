import fs from 'node:fs'

const file = 'src/main/core/decode.ts'
const source = fs.readFileSync(file, 'utf8')
const fixed = source.replace(/\0/g, '\\u0000')
fs.writeFileSync(file, fixed)
console.log('normalized NUL literals in', file)
