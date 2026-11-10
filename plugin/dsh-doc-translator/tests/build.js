/**
 * Builders for small Office packages used by the tests. They write the same
 * parts a real file has, with the tricky structures a translator must survive.
 */

import { writeZip } from '../zip.js'

const entry = (name, text) => ({ name, data: Buffer.from(text, 'utf8') })
const XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'

/** Body paragraphs that exercise runs, links, tabs, breaks, deletions and nested paragraphs. */
export const DOCX_BODY = [
  '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="40"/></w:rPr><w:t>Annual report</w:t></w:r></w:p>',
  '<w:p><w:r><w:t xml:space="preserve">This is </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>very important</w:t></w:r><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:r><w:rPr><w:i/><w:lang w:val="en-US"/></w:rPr><w:t>urgent</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>',
  '<w:p><w:r><w:t xml:space="preserve">Visit </w:t></w:r><w:hyperlink r:id="rId5"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>our website</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> for details &amp; more.</w:t></w:r></w:p>',
  '<w:p><w:r><w:t>Name</w:t><w:tab/><w:t>Value</w:t><w:br/><w:t>Second line</w:t></w:r></w:p>',
  '<w:p><w:r><w:t>Before the break</w:t><w:br w:type="page"/></w:r></w:p>',
  '<w:p><w:r><w:t>12345</w:t></w:r></w:p>',
  '<w:p><w:del w:id="1" w:author="a"><w:r><w:delText>old text</w:delText></w:r></w:del><w:r><w:t>kept text</w:t></w:r></w:p>',
  '<w:p><w:r><w:t>Outer text</w:t></w:r><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:txbxContent><w:p><w:r><w:t>Inside box</w:t></w:r></w:p></w:txbxContent></wp:inline></w:drawing></w:r></w:p>',
  '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell one</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell two</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
  '<w:p/>',
]

/** Build a .docx package. */
export function buildDocx({ body = DOCX_BODY, header, extra = [] } = {}) {
  const entries = [
    entry('[Content_Types].xml', `${XMLDECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}</Types>`),
    entry('_rels/.rels', `${XMLDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    entry('word/_rels/document.xml.rels', `${XMLDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/>${header ? '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' : ''}</Relationships>`),
    entry('word/document.xml', `${XMLDECL}<w:document ${NS_W}><w:body>${body.join('')}<w:sectPr>${header ? '<w:headerReference w:type="default" r:id="rId6"/>' : ''}</w:sectPr></w:body></w:document>`),
    ...extra,
  ]
  if (header) entries.push(entry('word/header1.xml', `${XMLDECL}<w:hdr ${NS_W}>${header}</w:hdr>`))
  return writeZip(entries)
}

const NS_A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const rels = items => `${XMLDECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`
const THEME = `${XMLDECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements><a:clrScheme name="c"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F1F1F"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="f"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="m"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

/** Slide shapes: a title, a body with mixed runs, a break, a field and a notes-free table-less layout. */
export const PPTX_SHAPES = [
  '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="800000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US" sz="3200" b="1"/><a:t>Quarterly results</a:t></a:r></a:p></p:txBody></p:sp>',
  '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="3000000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US" sz="2000"/><a:t>Revenue grew </a:t></a:r><a:r><a:rPr lang="en-US" sz="2000" b="1"/><a:t>strongly</a:t></a:r><a:r><a:rPr lang="vi-VN" sz="2000"/><a:t> this quarter</a:t></a:r><a:br><a:rPr lang="en-US" sz="2000"/></a:br><a:r><a:rPr lang="en-US" sz="2000"/><a:t>Second line</a:t></a:r></a:p><a:p><a:fld id="{B1}" type="slidenum"><a:rPr lang="en-US"/><a:t>3</a:t></a:fld></a:p></p:txBody></p:sp>',
]

/** Build a .pptx package with one slide. */
export function buildPptx({ shapes = PPTX_SHAPES } = {}) {
  const ct = `${XMLDECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`
  const tree = '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
  return writeZip([
    entry('[Content_Types].xml', ct),
    entry('_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']])),
    entry('ppt/presentation.xml', `${XMLDECL}<p:presentation ${NS_A}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`),
    entry('ppt/_rels/presentation.xml.rels', rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'theme', 'theme/theme1.xml']])),
    entry('ppt/slideMasters/slideMaster1.xml', `${XMLDECL}<p:sldMaster ${NS_A}>${tree}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`),
    entry('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']])),
    entry('ppt/slideLayouts/slideLayout1.xml', `${XMLDECL}<p:sldLayout ${NS_A} type="blank">${tree}</p:spTree></p:cSld></p:sldLayout>`),
    entry('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])),
    entry('ppt/theme/theme1.xml', THEME),
    entry('ppt/slides/slide1.xml', `${XMLDECL}<p:sld ${NS_A}>${tree}${shapes.join('')}</p:spTree></p:cSld></p:sld>`),
    entry('ppt/slides/_rels/slide1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']])),
  ])
}

/** Shared strings: plain, rich text with two formats, phonetic text, and spaces that must be kept. */
export const XLSX_STRINGS = [
  '<si><t>Total revenue</t></si>',
  '<si><r><rPr><b/><sz val="11"/></rPr><t>Net</t></r><r><rPr><sz val="11"/></rPr><t xml:space="preserve"> profit margin</t></r></si>',
  '<si><t>12345</t></si>',
  '<si><t xml:space="preserve">  Padded text  </t></si>',
  '<si><t>Tokyo</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si>',
]

/** Build a .xlsx package with one sheet that references the shared strings. */
export function buildXlsx({ strings = XLSX_STRINGS } = {}) {
  const cells = strings.map((_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="s"><v>${i}</v></c></row>`).join('')
  return writeZip([
    entry('[Content_Types].xml', `${XMLDECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`),
    entry('_rels/.rels', rels([['rId1', 'officeDocument', 'xl/workbook.xml']])),
    entry('xl/workbook.xml', `${XMLDECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    entry('xl/_rels/workbook.xml.rels', rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'sharedStrings', 'sharedStrings.xml']])),
    entry('xl/worksheets/sheet1.xml', `${XMLDECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`),
    entry('xl/sharedStrings.xml', `${XMLDECL}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.join('')}</sst>`),
  ])
}
