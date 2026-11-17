import fs from 'node:fs'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import type {
  SlideParagraph,
  SlidePicture,
  SlidePreview,
  SlideTable,
  SlideTextBlock
} from '../../../shared/types'
import type { ParsedDoc, TextBlock } from './base'

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const DEFAULT_WIDTH = 12192000
const DEFAULT_HEIGHT = 6858000
/** 单张图片超过该大小就不内联预览，避免弹窗卡死 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

const TITLE_PLACEHOLDERS = new Set(['title', 'ctrTitle'])

interface SlideParts {
  index: number
  xml: string
  rels: Map<string, string>
  notes: string
}

interface SlideShapeData {
  preview: SlidePreview
  title: string
  lines: string[]
}

export interface SlidesPreviewData {
  width: number
  height: number
  slides: SlidePreview[]
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, 'text/xml')
}

function elementChildren(node: Node | null | undefined): Element[] {
  const out: Element[] = []
  if (!node) return out
  let child = node.firstChild
  while (child) {
    if (child.nodeType === 1) out.push(child as Element)
    child = child.nextSibling
  }
  return out
}

function findChild(node: Node | null | undefined, localName: string): Element | null {
  return elementChildren(node).find((element) => element.localName === localName) ?? null
}

function findDescendant(node: Node | null | undefined, localName: string): Element | null {
  for (const child of elementChildren(node)) {
    if (child.localName === localName) return child
    const found = findDescendant(child, localName)
    if (found) return found
  }
  return null
}

function findAll(node: Node | null | undefined, localName: string, out: Element[] = []): Element[] {
  for (const child of elementChildren(node)) {
    if (child.localName === localName) out.push(child)
    findAll(child, localName, out)
  }
  return out
}

function num(value: string | null | undefined, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function relId(element: Element): string {
  return element.getAttributeNS(REL_NS, 'id') || element.getAttribute('r:id') || ''
}

function alignOf(value: string | null): SlideParagraph['align'] {
  if (value === 'ctr') return 'center'
  if (value === 'r') return 'right'
  return 'left'
}

function anchorOf(value: string | null): SlideTextBlock['anchor'] {
  if (value === 'ctr') return 'middle'
  if (value === 'b') return 'bottom'
  return 'top'
}

/** 把关系文件里的相对 Target 解析成 zip 内的绝对路径 */
function resolvePart(baseDir: string, target: string): string {
  let decoded = target
  try {
    decoded = decodeURIComponent(target)
  } catch {
    // 保留原始 Target
  }
  if (decoded.startsWith('/')) return decoded.slice(1)
  const segments = `${baseDir}/${decoded}`.split('/')
  const output: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') output.pop()
    else output.push(segment)
  }
  return output.join('/')
}

function parseRelationships(xml: string | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!xml) return map
  for (const relation of findAll(parseXml(xml), 'Relationship')) {
    const id = relation.getAttribute('Id')
    const target = relation.getAttribute('Target')
    if (id && target) map.set(id, target)
  }
  return map
}

function imageMime(filePath: string): string | null {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    default:
      // EMF / WMF 等格式浏览器无法直接显示
      return null
  }
}

interface Xfrm {
  x: number
  y: number
  w: number
  h: number
}

function readXfrm(container: Element | null): Xfrm | null {
  const xfrm = findDescendant(container, 'xfrm')
  if (!xfrm) return null
  const off = findChild(xfrm, 'off')
  const ext = findChild(xfrm, 'ext')
  if (!off || !ext) return null
  return {
    x: num(off.getAttribute('x')),
    y: num(off.getAttribute('y')),
    w: num(ext.getAttribute('cx')),
    h: num(ext.getAttribute('cy'))
  }
}

function readParagraph(paragraph: Element, defaultSize: number): SlideParagraph | null {
  const text = findAll(paragraph, 't')
    .map((node) => node.textContent ?? '')
    .join('')
    .replace(/\s+$/, '')
  if (!text.trim()) return null

  const pPr = findChild(paragraph, 'pPr')
  const defRPr = pPr ? findChild(pPr, 'defRPr') : null
  const run = findChild(paragraph, 'r')
  const rPr = run ? findChild(run, 'rPr') : null
  const size = rPr?.getAttribute('sz') ?? defRPr?.getAttribute('sz')
  const bold = rPr?.getAttribute('b') ?? defRPr?.getAttribute('b')
  return {
    text,
    size: size ? num(size, defaultSize * 100) / 100 : defaultSize,
    bold: bold === '1' || bold === 'true',
    level: num(pPr?.getAttribute('lvl'), 0),
    align: alignOf(pPr?.getAttribute('algn') ?? null)
  }
}

function readPlaceholderType(shape: Element): string {
  const nvPr = findDescendant(findChild(shape, 'nvSpPr'), 'nvPr')
  const placeholder = nvPr ? findChild(nvPr, 'ph') : null
  return placeholder?.getAttribute('type') ?? ''
}

function readTextShape(shape: Element): {
  block: SlideTextBlock | null
  lines: string[]
  title: boolean
} {
  const placeholderType = readPlaceholderType(shape)
  const title = TITLE_PLACEHOLDERS.has(placeholderType)
  const body = findChild(shape, 'txBody')
  if (!body) return { block: null, lines: [], title }

  const paragraphs = elementChildren(body)
    .filter((element) => element.localName === 'p')
    .map((element) => readParagraph(element, title ? 40 : 18))
    .filter((value): value is SlideParagraph => value !== null)
  const lines = paragraphs.map((paragraph) => paragraph.text)
  if (!paragraphs.length) return { block: null, lines, title }

  const xfrm = readXfrm(shape)
  if (!xfrm) return { block: null, lines, title }

  const bodyPr = findChild(body, 'bodyPr')
  // PowerPoint 的自动缩放会记录在 normAutofit 的 fontScale 里，不还原会导致文字折行
  const fontScale = num(findDescendant(bodyPr, 'normAutofit')?.getAttribute('fontScale'), 100000) / 100000
  if (fontScale > 0 && fontScale < 1) {
    for (const paragraph of paragraphs) paragraph.size *= fontScale
  }
  return {
    block: { ...xfrm, anchor: anchorOf(bodyPr?.getAttribute('anchor') ?? null), paragraphs },
    lines,
    title
  }
}

function readTable(frame: Element): { table: SlideTable | null; lines: string[] } {
  const tbl = findDescendant(frame, 'tbl')
  const xfrm = readXfrm(frame)
  if (!tbl || !xfrm) return { table: null, lines: [] }

  const rows = elementChildren(tbl)
    .filter((element) => element.localName === 'tr')
    .map((row) =>
      elementChildren(row)
        .filter((cell) => cell.localName === 'tc')
        .map((cell) =>
          findAll(cell, 'p')
            .map((paragraph) =>
              findAll(paragraph, 't')
                .map((node) => node.textContent ?? '')
                .join('')
                .trim()
            )
            .filter(Boolean)
            .join('\n')
        )
    )
    .filter((row) => row.some(Boolean))

  if (!rows.length) return { table: null, lines: [] }
  return {
    table: { ...xfrm, rows },
    lines: rows.map((row) => row.join(' | '))
  }
}

async function readPicture(
  picture: Element,
  rels: Map<string, string>,
  baseDir: string,
  zip: JSZip,
  mediaCache: Map<string, string | null>
): Promise<SlidePicture | null> {
  const xfrm = readXfrm(picture)
  if (!xfrm) return null
  const blip = findDescendant(picture, 'blip')
  const embed = blip
    ? blip.getAttributeNS(REL_NS, 'embed') || blip.getAttribute('r:embed')
    : ''
  const target = embed ? rels.get(embed) : undefined
  if (!target) return null

  const path = resolvePart(baseDir, target)
  const mime = imageMime(path)
  if (!mime) return null

  if (!mediaCache.has(path)) {
    try {
      const file = zip.file(path)
      const data = file ? await file.async('base64') : ''
      const bytes = (data.length * 3) / 4
      mediaCache.set(
        path,
        data && bytes <= MAX_IMAGE_BYTES ? `data:${mime};base64,${data}` : null
      )
    } catch {
      mediaCache.set(path, null)
    }
  }
  const src = mediaCache.get(path)
  return src ? { ...xfrm, src } : null
}

function readBackground(slide: Node | null | undefined): string {
  const background = findDescendant(slide, 'bg')
  if (!background) return '#ffffff'
  const color = findDescendant(background, 'srgbClr')?.getAttribute('val')
  return color && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : '#ffffff'
}

function readNotesText(notesXml: string): string {
  return findAll(parseXml(notesXml), 'p')
    .map((paragraph) =>
      findAll(paragraph, 't')
        .map((node) => node.textContent ?? '')
        .join('')
        .trim()
    )
    .filter(Boolean)
    .join('\n')
}

async function readSlideRelationships(
  zip: JSZip,
  slidePath: string
): Promise<Map<string, string>> {
  const slash = slidePath.lastIndexOf('/')
  const relsPath = `${slidePath.slice(0, slash)}/_rels/${slidePath.slice(slash + 1)}.rels`
  const file = zip.file(relsPath)
  return parseRelationships(file ? await file.async('text') : undefined)
}

async function loadSlides(filePath: string): Promise<{
  zip: JSZip
  width: number
  height: number
  slides: SlideParts[]
}> {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(filePath))
  const presentationFile = zip.file('ppt/presentation.xml')
  const presentationXml = presentationFile ? await presentationFile.async('text') : undefined
  const presentation = presentationXml ? parseXml(presentationXml) : undefined

  const size = presentation ? findDescendant(presentation, 'sldSz') : null
  const width = num(size?.getAttribute('cx'), DEFAULT_WIDTH) || DEFAULT_WIDTH
  const height = num(size?.getAttribute('cy'), DEFAULT_HEIGHT) || DEFAULT_HEIGHT

  const presentationRels = parseRelationships(
    await zip.file('ppt/_rels/presentation.xml.rels')?.async('text')
  )

  const ordered: string[] = []
  if (presentation) {
    for (const slideId of findAll(presentation, 'sldId')) {
      const target = presentationRels.get(relId(slideId))
      if (target) ordered.push(resolvePart('ppt', target))
    }
  }
  if (!ordered.length) {
    for (const name of Object.keys(zip.files)) {
      if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) ordered.push(name)
    }
    ordered.sort((left, right) => {
      const leftIndex = Number(left.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
      const rightIndex = Number(right.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
      return leftIndex - rightIndex
    })
  }

  const slides: SlideParts[] = []
  for (const [position, slidePath] of ordered.entries()) {
    const file = zip.file(slidePath)
    if (!file) continue
    const rels = await readSlideRelationships(zip, slidePath)
    let notes = ''
    for (const target of rels.values()) {
      const notesPath = resolvePart(slidePath.slice(0, slidePath.lastIndexOf('/')), target)
      if (notesPath.includes('/notesSlides/')) {
        const notesFile = zip.file(notesPath)
        if (notesFile) notes = readNotesText(await notesFile.async('text'))
      }
    }
    slides.push({ index: position + 1, xml: await file.async('text'), rels, notes })
  }

  return { zip, width, height, slides }
}

async function buildSlide(
  slide: SlideParts,
  zip: JSZip,
  mediaCache: Map<string, string | null>
): Promise<SlideShapeData> {
  const document = parseXml(slide.xml)
  const baseDir = 'ppt/slides'
  const preview: SlidePreview = {
    index: slide.index,
    background: readBackground(document),
    texts: [],
    pictures: [],
    tables: []
  }

  let title = ''
  const bodyLines: string[] = []
  const orderedLines: { y: number; x: number; lines: string[] }[] = []

  const tree = findDescendant(document, 'spTree')
  const visit = async (container: Element | null): Promise<void> => {
    for (const child of elementChildren(container)) {
      if (child.localName === 'sp') {
        const shape = readTextShape(child)
        if (shape.block) preview.texts.push(shape.block)
        if (shape.lines.length) {
          const xfrm = readXfrm(child)
          orderedLines.push({ y: xfrm?.y ?? 0, x: xfrm?.x ?? 0, lines: shape.lines })
          if (shape.title && !title) title = shape.lines[0]
        }
      } else if (child.localName === 'pic') {
        const picture = await readPicture(child, slide.rels, baseDir, zip, mediaCache)
        if (picture) preview.pictures.push(picture)
      } else if (child.localName === 'graphicFrame') {
        const table = readTable(child)
        if (table.table) preview.tables.push(table.table)
        if (table.lines.length) {
          const xfrm = readXfrm(child)
          orderedLines.push({ y: xfrm?.y ?? 0, x: xfrm?.x ?? 0, lines: table.lines })
        }
      } else if (child.localName === 'grpSp') {
        await visit(child)
      }
    }
  }
  await visit(tree)

  orderedLines.sort((left, right) => left.y - right.y || left.x - right.x)
  for (const entry of orderedLines) bodyLines.push(...entry.lines)
  if (!title) title = bodyLines[0] ?? ''

  if (slide.notes) bodyLines.push(`备注：${slide.notes}`)
  return { preview, title, lines: bodyLines }
}

async function loadPresentation(filePath: string): Promise<{
  width: number
  height: number
  slides: SlideShapeData[]
}> {
  const { zip, width, height, slides } = await loadSlides(filePath)
  const mediaCache = new Map<string, string | null>()
  const built: SlideShapeData[] = []
  for (const slide of slides) {
    built.push(await buildSlide(slide, zip, mediaCache))
  }
  return { width, height, slides: built }
}

export async function parsePptxFile(filePath: string, title: string): Promise<ParsedDoc> {
  const { slides } = await loadPresentation(filePath)
  const blocks: TextBlock[] = []
  for (const slide of slides) {
    const text = slide.lines.join('\n').trim()
    if (!text) continue
    blocks.push({
      text,
      headingPath: slide.title ? [slide.title] : [],
      page: slide.preview.index
    })
  }
  if (!blocks.length) {
    throw new Error(
      '这份 PPT 没有可提取的文字，可能是纯图片幻灯片。可以把关键页面截图作为图片导入，或先在 PowerPoint 中补充文字后再导入。'
    )
  }
  return { title, blocks }
}

export async function buildSlidesPreview(filePath: string): Promise<SlidesPreviewData> {
  const { width, height, slides } = await loadPresentation(filePath)
  return { width, height, slides: slides.map((slide) => slide.preview) }
}
