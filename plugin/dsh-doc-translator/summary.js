/**
 * Plain-text result of a translation, for the model: what was written, what
 * was checked, and what the user must be told. Statements about the layout
 * come only from checks that ran.
 *
 * @module dsh-doc-translator/summary
 */

const REASONS = {
  format_simplified: 'lines whose inline formatting (bold, italic, links) was merged into one style because the translation lost its markers',
  content_moved: 'lines whose text sat around an image or field inside one run; the text now precedes it',
}

/**
 * @param {object} input - `file`, `format`, `target`, `report` (from `translateOffice`), `layout` (from `verifyLayout`), `fontCheck` (from `checkFonts`), `notes`.
 * @returns {string} the digest.
 */
export function renderOfficeSummary({ file, format, target, report, layout, fontCheck, notes }) {
  const { segments, failures, warnings, expansion, stats } = report
  const lines = [
    `Translated the ${format} file into ${target}. Output: ${file}`,
    `Lines: ${segments.translated} of ${segments.total} translated${segments.failed ? `, ${segments.failed} left in the source language` : ''}. Model calls: ${stats.calls} (${Object.entries(stats.byModel).map(([m, n]) => `${m} x${n}`).join(', ')}), batches ${stats.batches}, fallbacks ${stats.fallbacks}.`,
  ]
  if (failures.length > 0) lines.push(`Not translated (first 5): ${failures.slice(0, 5).map(f => `${f.id} (${f.reason})`).join('; ')}`)
  if (layout?.checked) {
    lines.push(layout.samePages
      ? `Layout check: LibreOffice renders ${layout.originalPages} page(s) for both the original and the translation. Equal page counts do not prove identical layout.`
      : `Layout check: the page count changed from ${layout.originalPages} to ${layout.translatedPages}; the translation changed the layout. Tell the user.`)
  } else lines.push(`Layout check: not done (${layout?.reason ?? 'disabled'}). Do not say the layout was verified.`)
  for (const [reason, count] of Object.entries(warnings)) lines.push(`Formatting: ${count} ${REASONS[reason] ?? reason}.`)
  if (expansion.average !== null) lines.push(`Text length: translated lines are ${(expansion.average * 100).toFixed(0)}% of the source length on average.${expansion.longest.length ? ` Longest growth: ${expansion.longest.map(e => `${(e.ratio * 100).toFixed(0)}% ("${e.text}")`).join('; ')}. Text that grew may overflow its box or cell.` : ''}`)
  if (fontCheck?.checked) {
    const risky = fontCheck.fonts.filter(f => f.installed && f.coversTarget === false)
    const missing = fontCheck.fonts.filter(f => !f.installed)
    lines.push(`Fonts used: ${fontCheck.fonts.map(f => f.font).join(', ') || 'none named'}.${risky.length ? ` Installed here but without glyphs for the target language: ${risky.map(f => f.font).join(', ')}.` : ''}${missing.length ? ` Not installed on this machine (cannot check): ${missing.map(f => f.font).join(', ')}.` : ''}`)
  }
  for (const note of notes) lines.push(`Note: ${note}`)
  lines.push('Fonts, sizes and colours are kept as written in the file. Report only what is listed above; do not claim the result is identical to the original.')
  return lines.join('\n')
}

/**
 * Summary of a PDF or image translation.
 * @param {object} input - `file`, `extension`, `target`, `report` (from `translateScan`).
 * @returns {string} the digest.
 */
export function renderScanSummary({ file, extension, target, report }) {
  const { lines, pages, routes, render, stats, notes, failures } = report
  const out = [
    `Translated ${pages} page(s) into ${target}. Output: ${file}`,
    `Text source: ${routes.layer} page(s) read exactly from the PDF text layer (no OCR), ${routes.ocr} page(s) read with OCR.`,
    `Lines: ${lines.translated} of ${lines.total} translated${lines.failed ? `, ${lines.failed} left as in the original` : ''}. Model calls: ${stats.calls} (${Object.entries(stats.byModel).map(([m, n]) => `${m} x${n}`).join(', ')}).`,
  ]
  if (failures.length > 0) out.push(`Not translated (first 5): ${failures.slice(0, 5).map(f => `${f.id} (${f.reason})`).join('; ')}`)
  if (render.overflow > 0) out.push(`Layout: ${render.overflow} line(s) are wider than their original box and run past it.`)
  if (render.shrunk > 0) out.push(`Layout: ${render.shrunk} line(s) were drawn in a smaller size than the original to fit their box.`)
  for (const note of notes.slice(0, 6)) out.push(`OCR: ${note}`)
  out.push(extension === 'pdf'
    ? `The output PDF is made of page images: its text cannot be selected or searched${routes.layer > 0 ? ', although the text of the original could be' : ''}.`
    : 'The output is an image.')
  if (routes.layer > 0) {
    out.push('Pages read from the text layer keep the font family, size, colour and weight named in the PDF, drawn with an installed equivalent of that family (for example Arial as Liberation Sans), not the embedded font. Italic, and right or justified alignment, are approximated.')
  }
  if (routes.ocr > 0) {
    out.push('OCR pages: fonts are approximated. The page does not say which font it used, so lines are drawn in a sans-serif font that covers the target language, bold where the ink looked heavy, in the original ink colour. Text read wrongly by OCR is translated wrongly: tell the user to check these pages against the original.')
  }
  out.push('Numbers-only lines are left as they were.')
  return out.join('\n')
}
