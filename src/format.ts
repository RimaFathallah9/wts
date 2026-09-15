export const WA_TEXT_LIMIT = 4000;

export function toWhatsAppText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

export function chunkWhatsAppText(markdown: string): string[] {
  const text = toWhatsAppText(markdown);
  if (text.length <= WA_TEXT_LIMIT) return [text];
  return Array.from({ length: Math.ceil(text.length / WA_TEXT_LIMIT) }, (_, i) =>
    text.slice(i * WA_TEXT_LIMIT, (i + 1) * WA_TEXT_LIMIT),
  );
}
