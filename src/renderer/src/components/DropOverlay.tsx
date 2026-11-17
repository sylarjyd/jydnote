import { UploadCloud } from 'lucide-react'

export default function DropOverlay({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <div className="drop-overlay">
      <div className="drop-card">
        <UploadCloud size={36} />
        <strong>松开鼠标即可导入</strong>
        <span>支持 TXT / Markdown / Word / Excel / PDF / 图片，也可以拖入整个文件夹</span>
      </div>
    </div>
  )
}
