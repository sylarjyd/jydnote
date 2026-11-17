import { Folder, Home } from 'lucide-react'
import { flattenFolders } from '../lib/folders'

interface Props {
  folders: string[]
  value: string | null
  onChange: (folder: string | null) => void
  /** 高亮「当前」所在目录；传 null 表示根目录，未传则不显示标记 */
  current?: string | null
  emptyHint?: string
  disabled?: boolean
  rootLabel?: string
}

/** 目录选择列表：根目录 + 按层级缩进的目录，多处复用 */
export default function FolderPicker({
  folders,
  value,
  onChange,
  current,
  emptyHint,
  disabled,
  rootLabel = '知识库根目录'
}: Props) {
  const options = flattenFolders(folders)
  if (!options.length && current === undefined) {
    return <div className="doc-dialog-empty">{emptyHint ?? '还没有创建目录。'}</div>
  }

  return (
    <div className="folder-picker">
      <button
        type="button"
        className={`folder-option ${value === null ? 'selected' : ''}`}
        disabled={disabled}
        onClick={() => onChange(null)}
      >
        <Home size={14} />
        <span className="folder-option-name">{rootLabel}</span>
        {current === null ? <em>当前</em> : null}
      </button>
      {options.map((option) => (
        <button
          key={option.path}
          type="button"
          className={`folder-option ${value === option.path ? 'selected' : ''}`}
          style={{ paddingLeft: `${10 + option.depth * 16}px` }}
          title={option.path}
          disabled={disabled}
          onClick={() => onChange(option.path)}
        >
          <Folder size={14} />
          <span className="folder-option-name">{option.name}</span>
          {current === option.path ? <em>当前</em> : null}
        </button>
      ))}
    </div>
  )
}
