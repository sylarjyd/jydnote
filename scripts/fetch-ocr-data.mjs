/**
 * 准备 Tesseract 离线语言数据到 resources/tessdata。
 *
 * 优先复用 devDependencies 中的 @tesseract.js-data/* 数据包（npm 安装即可，
 * 无需再次联网）；缺失时再尝试 jsDelivr / GitHub raw 下载。
 *
 * 用法：
 *   npm run fetch-ocr             # 默认 chi_sim + eng
 *   npm run fetch-ocr -- chi_sim  # 只下简体中文
 *
 * 网络受限时可自行设置镜像：
 *   TESSDATA_BASE_URL=https://your-mirror/tessdata_fast npm run fetch-ocr
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET_DIR = path.join(ROOT, 'resources', 'tessdata')
const DEFAULT_LANGS = ['chi_sim', 'eng']
const MIN_BYTES = 200 * 1024

const MIRRORS = [
  process.env.TESSDATA_BASE_URL,
  'https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main',
  'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main'
].filter(Boolean)

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const langs = args.length ? args : DEFAULT_LANGS

async function isUsable(file) {
  try {
    const stat = await fsp.stat(file)
    if (stat.size < MIN_BYTES) return false
    const handle = await fsp.open(file, 'r')
    try {
      const { buffer } = await handle.read(Buffer.alloc(2), 0, 2, 0)
      return buffer[0] === 0x1f && buffer[1] === 0x8b
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

async function copyFromPackage(lang, dest) {
  const packageDir = path.join(ROOT, 'node_modules', '@tesseract.js-data', lang)
  for (const variant of ['4.0.0_best_int', '4.0.0']) {
    const candidate = path.join(packageDir, variant, `${lang}.traineddata.gz`)
    if (await isUsable(candidate)) {
      await fsp.copyFile(candidate, dest)
      const stat = await fsp.stat(dest)
      console.log(`  ✓ 复用数据包 @tesseract.js-data/${lang}（${formatSize(stat.size)}）`)
      return true
    }
  }
  return false
}

async function download(lang) {
  const fileName = `${lang}.traineddata.gz`
  const dest = path.join(TARGET_DIR, fileName)

  if (await isUsable(dest)) {
    const stat = await fsp.stat(dest)
    console.log(`- ${fileName} 已存在（${formatSize(stat.size)}），跳过`)
    return
  }

  console.log(`- 准备 ${fileName}`)
  if (await copyFromPackage(lang, dest)) return

  let lastError = null
  for (const base of MIRRORS) {
    const url = `${base.replace(/\/$/, '')}/${fileName}`
    console.log(`- 下载 ${url}`)
    try {
      const response = await fetch(url)
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`)
      }
      const temp = `${dest}.part`
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp))
      if (!(await isUsable(temp))) throw new Error('文件损坏或不是 gzip 数据')
      await fsp.rename(temp, dest)
      const stat = await fsp.stat(dest)
      console.log(`  ✓ ${fileName}（${formatSize(stat.size)}）`)
      return
    } catch (error) {
      lastError = error
      await fsp.rm(`${dest}.part`, { force: true }).catch(() => undefined)
      console.warn(`  失败：${error.message}`)
    }
  }

  throw new Error(
    `无法获取 ${fileName}：${lastError?.message ?? '未知错误'}。` +
      ' 可手动从 tesseract-ocr/tessdata_fast 下载后放入 resources/tessdata，' +
      ' 或设置 TESSDATA_BASE_URL 指向可用镜像。'
  )
}

await fsp.mkdir(TARGET_DIR, { recursive: true })
console.log(`OCR 语言数据目录：${TARGET_DIR}`)

for (const lang of langs) {
  await download(lang)
}

console.log('\n完成。打包时 resources/tessdata 会一并复制到安装目录。')
