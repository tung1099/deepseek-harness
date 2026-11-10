/**
 * Language names the tool accepts, with the codes `fc-list` understands and
 * the writing systems that need special handling.
 *
 * @module dsh-doc-translator/lang
 */

const LANGUAGES = [
  ['en', ['english', 'tiếng anh', 'anh', 'en'], {}],
  ['vi', ['vietnamese', 'tiếng việt', 'việt', 'vi'], {}],
  ['fr', ['french', 'tiếng pháp', 'français', 'fr'], {}],
  ['de', ['german', 'tiếng đức', 'deutsch', 'de'], {}],
  ['es', ['spanish', 'tiếng tây ban nha', 'español', 'es'], {}],
  ['pt', ['portuguese', 'tiếng bồ đào nha', 'pt'], {}],
  ['it', ['italian', 'tiếng ý', 'it'], {}],
  ['ru', ['russian', 'tiếng nga', 'ru'], {}],
  ['zh-cn', ['chinese', 'simplified chinese', 'tiếng trung', 'trung', 'zh', 'zh-cn'], { cjk: true }],
  ['zh-tw', ['traditional chinese', 'tiếng trung phồn thể', 'zh-tw'], { cjk: true }],
  ['ja', ['japanese', 'tiếng nhật', 'nhật', 'ja'], { cjk: true }],
  ['ko', ['korean', 'tiếng hàn', 'hàn', 'ko'], { cjk: true }],
  ['th', ['thai', 'tiếng thái', 'th'], {}],
  ['id', ['indonesian', 'tiếng indonesia', 'id'], {}],
  ['ms', ['malay', 'tiếng malaysia', 'ms'], {}],
  ['hi', ['hindi', 'tiếng hindi', 'hi'], {}],
  ['tr', ['turkish', 'tiếng thổ nhĩ kỳ', 'tr'], {}],
  ['pl', ['polish', 'tiếng ba lan', 'pl'], {}],
  ['nl', ['dutch', 'tiếng hà lan', 'nl'], {}],
  ['ar', ['arabic', 'tiếng ả rập', 'ar'], { rtl: true }],
  ['he', ['hebrew', 'tiếng do thái', 'he'], { rtl: true }],
]

const BY_NAME = new Map(LANGUAGES.flatMap(([code, names, flags]) => names.map(name => [name, { code, ...flags }])))

/**
 * Look up a language by name or code.
 * @param {string} name - for example "English", "tiếng Việt" or "ja".
 * @returns {{ code: string | null, cjk?: boolean, rtl?: boolean }} the code (`null` when the name is not known) and writing-system flags.
 */
export function languageInfo(name) {
  return BY_NAME.get(String(name ?? '').trim().toLowerCase()) ?? { code: null }
}
