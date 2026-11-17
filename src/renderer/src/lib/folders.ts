export interface FolderOption {
  path: string
  name: string
  depth: number
}

/** 把完整路径列表整理成按层级排列的选项，缺少的上级目录会自动补上 */
export function flattenFolders(folders: string[]): FolderOption[] {
  const children = new Map<string, Set<string>>()
  for (const folder of folders) {
    const segments = folder.split('/').filter(Boolean)
    let parent = ''
    for (const segment of segments) {
      const path = parent ? `${parent}/${segment}` : segment
      const siblings = children.get(parent)
      if (siblings) siblings.add(path)
      else children.set(parent, new Set([path]))
      parent = path
    }
  }

  const options: FolderOption[] = []
  const walk = (parent: string, depth: number): void => {
    const siblings = [...(children.get(parent) ?? [])].sort((a, b) =>
      a.localeCompare(b, 'zh-Hans-CN')
    )
    for (const path of siblings) {
      options.push({ path, name: path.slice(path.lastIndexOf('/') + 1), depth })
      walk(path, depth + 1)
    }
  }
  walk('', 0)
  return options
}

export function folderLabel(folder: string | null | undefined): string {
  return folder?.trim() ? folder : '知识库根目录'
}
