import { Info, X } from 'lucide-react'

interface Props {
  message: string | null
  onClose: () => void
}

export default function Toast({ message, onClose }: Props) {
  if (!message) return null
  return (
    <div className="toast">
      <Info size={15} />
      <span>{message}</span>
      <button type="button" onClick={onClose} title="关闭">
        <X size={13} />
      </button>
    </div>
  )
}
