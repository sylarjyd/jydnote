import { useEffect, useState } from 'react'
import type { DocPreview, SheetPreview, SlidePreview } from '../../../shared/types'
import Markdown from './Markdown'

const EMU_PER_PIXEL = 9525

function percent(value: number, total: number): string {
  if (!total) return '0%'
  return `${Math.max(0, (value / total) * 100)}%`
}

/** 把磅值换算成相对于幻灯片宽度的 cqw 单位，让预览随弹窗宽度等比缩放 */
function fontSize(value: number, slideWidth: number): string {
  const pixels = value * (96 / 72)
  const slidePixels = slideWidth / EMU_PER_PIXEL
  return `${(pixels / slidePixels) * 100}cqw`
}

function SheetPreviewView({ sheets }: { sheets: SheetPreview[] }) {
  const [active, setActive] = useState(0)
  useEffect(() => setActive(0), [sheets])
  const sheet = sheets[Math.min(active, sheets.length - 1)]
  if (!sheet) return null

  return (
    <div className="sheet-preview">
      {sheets.length > 1 ? (
        <div className="sheet-tabs" role="tablist" aria-label="工作表">
          {sheets.map((item, index) => (
            <button
              key={`${item.name}-${index}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              className={`sheet-tab ${index === active ? 'active' : ''}`}
              onClick={() => setActive(index)}
            >
              {item.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="sheet-scroll">
        <table className="sheet-table">
          <tbody>
            {sheet.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) =>
                  rowIndex === 0 ? (
                    <th key={cellIndex}>{cell}</th>
                  ) : (
                    <td key={cellIndex}>{cell}</td>
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.truncated ? (
        <p className="preview-note">表格较大，仅预览左上角部分内容，完整内容请打开原文件。</p>
      ) : null}
    </div>
  )
}

function SlideCard({
  slide,
  width,
  height
}: {
  slide: SlidePreview
  width: number
  height: number
}) {
  return (
    <figure className="slide-card">
      <div
        className="slide-canvas"
        style={{ aspectRatio: `${width} / ${height}`, background: slide.background }}
      >
        {slide.texts.map((block, blockIndex) => (
          <div
            key={`text-${blockIndex}`}
            className="slide-text"
            style={{
              left: percent(block.x, width),
              top: percent(block.y, height),
              width: percent(block.w, width),
              height: percent(block.h, height),
              justifyContent:
                block.anchor === 'middle'
                  ? 'center'
                  : block.anchor === 'bottom'
                    ? 'flex-end'
                    : 'flex-start'
            }}
          >
            {block.paragraphs.map((paragraph, paragraphIndex) => (
              <p
                key={paragraphIndex}
                style={{
                  fontSize: fontSize(paragraph.size, width),
                  fontWeight: paragraph.bold ? 600 : 400,
                  textAlign: paragraph.align,
                  marginLeft: `${paragraph.level * 3}%`
                }}
              >
                {paragraph.text}
              </p>
            ))}
          </div>
        ))}
        {slide.tables.map((table, tableIndex) => (
          <div
            key={`table-${tableIndex}`}
            className="slide-table"
            style={{
              left: percent(table.x, width),
              top: percent(table.y, height),
              width: percent(table.w, width),
              height: percent(table.h, height)
            }}
          >
            <table>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {slide.pictures.map((picture, pictureIndex) => (
          <img
            key={`picture-${pictureIndex}`}
            className="slide-picture"
            src={picture.src}
            alt="幻灯片图片"
            style={{
              left: percent(picture.x, width),
              top: percent(picture.y, height),
              width: percent(picture.w, width),
              height: percent(picture.h, height)
            }}
          />
        ))}
        <span className="slide-number">{slide.index}</span>
      </div>
      <figcaption>第 {slide.index} 张</figcaption>
    </figure>
  )
}

function SlidesPreviewView({
  width,
  height,
  slides
}: {
  width: number
  height: number
  slides: SlidePreview[]
}) {
  return (
    <div className="slides-preview">
      <p className="preview-note slides-summary">
        共 {slides.length} 张幻灯片；文字与图片按原始位置近似还原，图表、动画与主题字体请打开原文件查看。
      </p>
      {slides.map((slide) => (
        <SlideCard key={slide.index} slide={slide} width={width} height={height} />
      ))}
    </div>
  )
}

export default function DocPreviewView({ preview }: { preview: DocPreview }) {
  switch (preview.type) {
    case 'markdown':
      return (
        <div className="doc-markdown">
          <Markdown content={preview.markdown} />
        </div>
      )
    case 'pdf':
      return (
        <div className="doc-pdf">
          <iframe title="PDF 预览" src={preview.url} />
        </div>
      )
    case 'image':
      return (
        <div className="doc-image">
          <img src={preview.url} alt="图片预览" />
        </div>
      )
    case 'sheets':
      return <SheetPreviewView sheets={preview.sheets} />
    case 'slides':
      return (
        <SlidesPreviewView width={preview.width} height={preview.height} slides={preview.slides} />
      )
  }
}
