const PREVIEW_SOURCE_CHARACTERS = 2_048
const PREVIEW_OUTPUT_CHARACTERS = 512

export function trajectoryPreviewText(text: string): string {
  const source = text.slice(0, PREVIEW_SOURCE_CHARACTERS)
  const compact = source.replace(/[`*_#>\[\]()]/g, '').replace(/\s+/g, ' ').trim()
  const preview = compact.slice(0, PREVIEW_OUTPUT_CHARACTERS).trimEnd()
  return source.length < text.length || preview.length < compact.length ? `${preview}…` : preview
}
