// FNV-1a over UTF-16 units: names a text in props without sending it again
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }

  return `${text.length}:${(h >>> 0).toString(36)}`
}
