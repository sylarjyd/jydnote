const CJK_RUN = /[㐀-䶿一-鿿豈-﫿]+/g
const LATIN_WORD = /[a-z0-9][a-z0-9_+#.-]*/g

/**
 * 面向中文的轻量分词：
 * - 拉丁字母/数字按词切
 * - 中文按「单字 + 二元组」切，零依赖，召回尚可
 * 用于 BM25 关键词检索，不用于向量模型。
 */
export function tokenize(text: string): string[] {
  if (!text) return []
  const lower = text.toLowerCase()
  const tokens: string[] = []

  const latin = lower.match(LATIN_WORD)
  if (latin) tokens.push(...latin)

  const runs = lower.match(CJK_RUN)
  if (runs) {
    for (const run of runs) {
      if (run.length <= 2) {
        tokens.push(run)
        continue
      }
      for (let i = 0; i < run.length; i++) {
        tokens.push(run[i])
        if (i < run.length - 1) tokens.push(run.slice(i, i + 2))
      }
    }
  }

  return tokens
}
