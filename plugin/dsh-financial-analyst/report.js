/**
 * Self-contained HTML report for one analysis: tables, inline SVG charts,
 * anomaly flags, formulas, and the URL of every source read.
 *
 * The report states a fixed disclaimer and contains no buy, sell or hold
 * wording. Every figure comes from the analysis object; nothing is typed in by
 * the model.
 *
 * @module dsh-financial-analyst/report
 */

/** Disclaimer printed at the top of every report. */
export const DISCLAIMER = 'Báo cáo này chỉ trình bày và phân tích số liệu từ báo cáo tài chính đã công bố. '
  + 'Đây không phải khuyến nghị mua, bán hay nắm giữ cổ phiếu và không đưa ra giá mục tiêu. '
  + 'Các cờ bất thường chỉ là chỗ cần đọc thêm trong thuyết minh báo cáo tài chính, không phải kết luận về công ty.'

/** Ratio definitions printed in the report and returned by the tool. */
export const FORMULAS = [
  ['Doanh thu thuần', 'Mã 21001 trong báo cáo kết quả kinh doanh'],
  ['Biên lợi nhuận gộp', 'Lợi nhuận gộp (23100) / doanh thu thuần'],
  ['Biên lợi nhuận hoạt động', 'Lợi nhuận thuần từ hoạt động kinh doanh (23110) / doanh thu thuần'],
  ['Biên lợi nhuận ròng', 'Lợi nhuận sau thuế của công ty mẹ (23000) / doanh thu thuần'],
  ['ROE', 'Lợi nhuận sau thuế của công ty mẹ / vốn chủ sở hữu của công ty mẹ bình quân (đầu kỳ và cuối kỳ; vốn chủ của công ty mẹ = vốn chủ sở hữu 14000 trừ lợi ích cổ đông không kiểm soát 14240)'],
  ['P/E', 'Giá đóng cửa gần nhất / EPS TTM; EPS TTM = lợi nhuận sau thuế công ty mẹ 4 quý gần nhất / số cổ phiếu đang lưu hành hiện tại'],
  ['Nợ phải trả / vốn chủ', 'Nợ phải trả (13000) / vốn chủ sở hữu (14000)'],
  ['Nợ vay / vốn chủ', '(Vay và nợ ngắn hạn 13110 + vay và nợ dài hạn 13340) / vốn chủ sở hữu (14000)'],
  ['TTM', 'Tổng 4 quý liên tiếp gần nhất; số dư bảng cân đối lấy tại cuối quý gần nhất'],
]

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

const num = (value, digits = 2) => (typeof value === 'number' && Number.isFinite(value)
  ? value.toLocaleString('vi-VN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : '—')
const bn = value => (typeof value === 'number' ? num(value / 1e9, 0) : '—')
const pct = value => (typeof value === 'number' ? `${num(value, 1)}%` : '—')
const mult = value => (typeof value === 'number' ? `${num(value, 2)}x` : '—')

const W = 640
const H = 260
const PAD = { left: 56, right: 16, top: 28, bottom: 36 }

function scaleOf(values) {
  const finite = values.filter(value => typeof value === 'number' && Number.isFinite(value))
  const low = Math.min(0, ...finite)
  const high = Math.max(0, ...finite)
  const span = (high - low) || 1
  const top = high + span * 0.08
  const bottom = low < 0 ? low - span * 0.08 : 0
  return { top, bottom, y: value => PAD.top + (top - value) / (top - bottom) * (H - PAD.top - PAD.bottom) }
}

function axis(scale, unit) {
  const ticks = 4
  let out = ''
  for (let i = 0; i <= ticks; i++) {
    const value = scale.bottom + (scale.top - scale.bottom) * i / ticks
    const y = scale.y(value)
    out += `<line class="grid" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`
    out += `<text class="tick" x="${PAD.left - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end">${escapeHtml(num(value, Math.abs(value) < 10 ? 1 : 0))}</text>`
  }
  return `${out}<text class="tick" x="${PAD.left}" y="14">${escapeHtml(unit)}</text>`
}

function legend(series) {
  return `<div class="legend">${series.map((s, i) => `<span><i class="sw s${i}"></i>${escapeHtml(s.name)}</span>`).join('')}</div>`
}

/** Grouped bar chart: one group per category, one bar per series. */
export function barChart({ title, categories, series, unit }) {
  const all = series.flatMap(s => s.values)
  const scale = scaleOf(all)
  const group = (W - PAD.left - PAD.right) / categories.length
  const bar = Math.min(34, group / (series.length + 1))
  let body = axis(scale, unit)
  categories.forEach((category, ci) => {
    const x0 = PAD.left + group * ci + (group - bar * series.length) / 2
    series.forEach((s, si) => {
      const value = s.values[ci]
      if (typeof value !== 'number') return
      const y = scale.y(Math.max(value, 0))
      const h = Math.abs(scale.y(value) - scale.y(0))
      body += `<rect class="bar s${si}" x="${(x0 + bar * si).toFixed(1)}" y="${y.toFixed(1)}" width="${(bar - 2).toFixed(1)}" height="${h.toFixed(1)}"><title>${escapeHtml(`${category} · ${s.name}: ${num(value, 1)} ${unit}`)}</title></rect>`
    })
    body += `<text class="tick" x="${(PAD.left + group * (ci + 0.5)).toFixed(1)}" y="${H - 12}" text-anchor="middle">${escapeHtml(category)}</text>`
  })
  return figure(title, series, body)
}

/** Line chart over ordered categories; null values break the line. */
export function lineChart({ title, categories, series, unit }) {
  const scale = scaleOf(series.flatMap(s => s.values))
  const step = (W - PAD.left - PAD.right) / categories.length
  const x = ci => PAD.left + step * (ci + 0.5)
  let body = axis(scale, unit)
  categories.forEach((category, ci) => {
    body += `<text class="tick" x="${x(ci).toFixed(1)}" y="${H - 12}" text-anchor="middle">${escapeHtml(category)}</text>`
  })
  series.forEach((s, si) => {
    let path = ''
    let pen = false
    s.values.forEach((value, ci) => {
      if (typeof value !== 'number') { pen = false; return }
      path += `${pen ? 'L' : 'M'}${x(ci).toFixed(1)},${scale.y(value).toFixed(1)}`
      pen = true
    })
    body += `<path class="line s${si}" d="${path}"/>`
    s.values.forEach((value, ci) => {
      if (typeof value !== 'number') return
      body += `<circle class="dot s${si}" cx="${x(ci).toFixed(1)}" cy="${scale.y(value).toFixed(1)}" r="3.5"><title>${escapeHtml(`${categories[ci]} · ${s.name}: ${num(value, 1)} ${unit}`)}</title></circle>`
    })
  })
  return figure(title, series, body)
}

/** Horizontal bars, one per company, with the target highlighted and an optional peer-median marker. */
export function peerBars({ title, rows, unit, median }) {
  const present = rows.filter(row => typeof row.value === 'number')
  const rowH = 26
  const height = PAD.top + present.length * rowH + 16
  const values = present.map(row => row.value)
  if (typeof median === 'number') values.push(median)
  const high = Math.max(0, ...values)
  const low = Math.min(0, ...values)
  const span = (high - low) || 1
  const left = 70
  const right = 70
  const x = value => left + (value - low) / span * (W - left - right)
  let body = `<text class="tick" x="${left}" y="14">${escapeHtml(unit)}</text>`
  present.forEach((row, i) => {
    const y = PAD.top + i * rowH
    const x0 = x(Math.min(0, row.value))
    const w = Math.abs(x(row.value) - x(0))
    body += `<text class="tick" x="${left - 8}" y="${y + 15}" text-anchor="end">${escapeHtml(row.label)}</text>`
    body += `<rect class="bar ${row.highlight ? 's0' : 's3'}" x="${x0.toFixed(1)}" y="${y + 3}" width="${w.toFixed(1)}" height="${rowH - 8}"><title>${escapeHtml(`${row.label}: ${num(row.value, 2)} ${unit}`)}</title></rect>`
    body += `<text class="tick" x="${W - 8}" y="${y + 15}" text-anchor="end">${escapeHtml(num(row.value, 2))}</text>`
  })
  if (typeof median === 'number') {
    body += `<line class="median" x1="${x(median).toFixed(1)}" x2="${x(median).toFixed(1)}" y1="${PAD.top - 6}" y2="${height - 12}"/>`
    body += `<text class="tick" x="${x(median).toFixed(1)}" y="${height - 2}" text-anchor="middle">Trung vị cùng ngành ${escapeHtml(num(median, 2))}</text>`
  }
  return `<figure><figcaption>${escapeHtml(title)}</figcaption><svg viewBox="0 0 ${W} ${height}" role="img" aria-label="${escapeHtml(title)}">${body}</svg></figure>`
}

function figure(title, series, body) {
  return `<figure><figcaption>${escapeHtml(title)}</figcaption>${legend(series)}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(title)}">${body}</svg></figure>`
}

function table(headers, rows, { highlightFirst = false } = {}) {
  const head = `<tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`
  const body = rows.map((row, i) => `<tr${highlightFirst && i === 0 ? ' class="hl"' : ''}>${row.map(cell => `<td>${cell.html ?? escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
  return `<div class="scroll"><table>${head}${body}</table></div>`
}

const STYLE = `
:root{--bg:#fff;--fg:#1c2430;--muted:#5b6675;--line:#d9dee5;--card:#f6f8fa;--s0:#1f6feb;--s1:#e5822b;--s2:#2a9d6f;--s3:#9aa5b4;--warn:#b45309;--warnbg:#fff7ed}
@media (prefers-color-scheme:dark){:root{--bg:#10151c;--fg:#e6ebf2;--muted:#9aa5b4;--line:#2a3340;--card:#161d27;--s0:#58a6ff;--s1:#f0a15c;--s2:#4cc38a;--s3:#6b7686;--warn:#f0b36b;--warnbg:#2a2113}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 56px}h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.1rem;margin:32px 0 10px;padding-top:8px;border-top:1px solid var(--line)}
.sub{color:var(--muted);margin:0 0 16px}.disclaimer{background:var(--warnbg);border:1px solid var(--warn);border-radius:8px;padding:12px 14px;color:var(--fg)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:6px 8px;font-size:.88rem;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:600;font-size:.85rem}tr.hl td{background:var(--card);font-weight:600}
td.text{white-space:normal;text-align:left}.grid{stroke:var(--line);stroke-width:1}.tick{fill:var(--muted);font-size:11px}
figure{margin:12px 0 20px}figcaption{font-weight:600;margin-bottom:4px}svg{width:100%;height:auto;display:block}
.bar.s0,.sw.s0,.dot.s0{fill:var(--s0);background:var(--s0)}.bar.s1,.sw.s1,.dot.s1{fill:var(--s1);background:var(--s1)}.bar.s2,.sw.s2,.dot.s2{fill:var(--s2);background:var(--s2)}.bar.s3{fill:var(--s3)}
.line{fill:none;stroke-width:2.2}.line.s0{stroke:var(--s0)}.line.s1{stroke:var(--s1)}.line.s2{stroke:var(--s2)}.median{stroke:var(--fg);stroke-dasharray:4 3;stroke-width:1.2}
.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:.85rem;margin-bottom:2px}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px}
.flag{border:1px solid var(--line);border-left:4px solid var(--warn);border-radius:6px;padding:10px 12px;margin:8px 0;background:var(--card)}.flag b{display:block}.flag small{color:var(--muted)}
ul.plain{padding-left:18px}a{color:var(--s0);word-break:break-all}td a{display:block;white-space:normal;text-align:left}.note{color:var(--muted);font-size:.9rem}
`

/**
 * Render the report.
 * @param {object} analysis - result of `analyze()`.
 * @returns {string} a complete HTML document.
 */
export function renderReport(analysis) {
  const { target, peers, rows, peerMedian, anomalies, notes, sources, skippedPeers } = analysis
  const view = target.ttm.view
  const m = view.metrics
  const annual = target.annual
  const years = annual.map(a => String(a.year))
  const industryLine = analysis.targetIndustry ? `Ngành: ${analysis.targetIndustry.name}` : ''

  const kpiRows = [
    ['P/E (TTM)', mult(target.valuation.pe), mult(peerMedian.pe), 'Giá / EPS TTM'],
    ['ROE (TTM)', pct(m.roe), pct(peerMedian.roe), 'LNST công ty mẹ / vốn chủ công ty mẹ bình quân'],
    ['Biên lợi nhuận gộp', pct(m.grossMargin), pct(peerMedian.grossMargin), 'Lợi nhuận gộp / doanh thu thuần'],
    ['Biên lợi nhuận hoạt động', pct(m.operatingMargin), pct(peerMedian.operatingMargin), 'LN thuần HĐKD / doanh thu thuần'],
    ['Biên lợi nhuận ròng', pct(m.netMargin), pct(peerMedian.netMargin), 'LNST công ty mẹ / doanh thu thuần'],
    ['Nợ phải trả / vốn chủ', mult(m.liabilitiesToEquity), mult(peerMedian.liabilitiesToEquity), 'Nợ phải trả / vốn chủ sở hữu'],
    ['Nợ vay / vốn chủ', mult(m.debtToEquity), mult(peerMedian.debtToEquity), 'Vay và nợ / vốn chủ sở hữu'],
  ]
  const annualRows = annual.map(a => [
    String(a.year), bn(a.revenue), bn(a.netProfit), pct(a.revenueGrowth), pct(a.profitGrowth),
    pct(a.grossMargin), pct(a.operatingMargin), pct(a.netMargin), pct(a.roe), mult(a.liabilitiesToEquity), mult(a.debtToEquity), mult(a.cashConversion),
  ])
  const peerRows = rows.map(r => [
    r.ticker, bn(r.marketCap), mult(r.pe), pct(r.roe), pct(r.grossMargin), pct(r.operatingMargin), pct(r.netMargin), mult(r.liabilitiesToEquity), mult(r.debtToEquity),
  ])

  const charts = []
  if (annual.length > 0) {
    charts.push(barChart({ title: 'Doanh thu thuần và lợi nhuận sau thuế công ty mẹ', categories: years, unit: 'tỷ đồng',
      series: [{ name: 'Doanh thu thuần', values: annual.map(a => (a.revenue === null ? null : a.revenue / 1e9)) }, { name: 'LNST công ty mẹ', values: annual.map(a => (a.netProfit === null ? null : a.netProfit / 1e9)) }] }))
    charts.push(lineChart({ title: 'Biên lợi nhuận và ROE theo năm', categories: years, unit: '%',
      series: [{ name: 'Biên gộp', values: annual.map(a => a.grossMargin) }, { name: 'Biên ròng', values: annual.map(a => a.netMargin) }, { name: 'ROE', values: annual.map(a => a.roe) }] }))
    charts.push(lineChart({ title: 'Nợ phải trả / vốn chủ và nợ vay / vốn chủ theo năm', categories: years, unit: 'lần',
      series: [{ name: 'Nợ phải trả / vốn chủ', values: annual.map(a => a.liabilitiesToEquity) }, { name: 'Nợ vay / vốn chủ', values: annual.map(a => a.debtToEquity) }] }))
  }
  if (peers.length > 0) {
    const bars = (key, label, unit) => peerBars({
      title: `${label}: ${target.ticker} so với các công ty cùng ngành`,
      unit,
      rows: rows.map((r, i) => ({ label: r.ticker, value: r[key], highlight: i === 0 })),
      median: peerMedian[key],
    })
    charts.push(bars('pe', 'P/E (TTM)', 'lần'), bars('roe', 'ROE (TTM)', '%'), bars('netMargin', 'Biên lợi nhuận ròng (TTM)', '%'), bars('liabilitiesToEquity', 'Nợ phải trả / vốn chủ', 'lần'))
  }

  const flagHtml = anomalies.length === 0
    ? '<p>Không có chỉ tiêu nào vượt các ngưỡng sàng lọc đang cấu hình.</p>'
    : anomalies.map(a => `<div class="flag"><b>${escapeHtml(a.title)}</b>${escapeHtml(a.detail)}<br><small>${escapeHtml(a.period)}</small></div>`).join('')

  const industryUsed = peers.length > 0
    ? [...new Set(peers.map(p => p.industry?.name).filter(Boolean))].join('; ')
    : ''

  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phân tích BCTC ${escapeHtml(target.ticker)}</title><style>${STYLE}</style></head>
<body><main>
<h1>Phân tích báo cáo tài chính: ${escapeHtml(target.ticker)}</h1>
<p class="sub">${escapeHtml(target.name)} · ${escapeHtml(target.floor ?? '')} · ${escapeHtml(industryLine)}</p>
<p class="sub">Giá đóng cửa ${num(target.price?.close ?? null, 0)} đồng (${escapeHtml(target.price?.date ?? 'không rõ')}) · TTM ${escapeHtml(view.period.from)} đến ${escapeHtml(view.period.to)} · Đọc dữ liệu lúc ${escapeHtml(analysis.fetchedAt)} (UTC)</p>
<div class="disclaimer"><b>Lưu ý.</b> ${escapeHtml(DISCLAIMER)}</div>

<h2>Chỉ số chính (TTM)</h2>
${table(['Chỉ số', target.ticker, `Trung vị cùng ngành${peers.length ? ` (${peers.length} công ty)` : ''}`, 'Cách tính'], kpiRows.map(r => [r[0], r[1], r[2], { html: `<span class="note">${escapeHtml(r[3])}</span>` }]))}

<h2>Cờ bất thường</h2>
${flagHtml}

<h2>Biểu đồ</h2>
${charts.join('\n')}

<h2>Số liệu theo năm (đơn vị: tỷ đồng)</h2>
${table(['Năm', 'Doanh thu', 'LNST mẹ', 'Tăng DT', 'Tăng LN', 'Biên gộp', 'Biên HĐ', 'Biên ròng', 'ROE', 'Nợ PT/VCSH', 'Nợ vay/VCSH', 'CFO/LNST'], annualRows)}

<h2>So sánh với công ty cùng ngành (TTM)</h2>
${table(['Mã', 'Vốn hóa (tỷ đồng)', 'P/E', 'ROE', 'Biên gộp', 'Biên HĐ', 'Biên ròng', 'Nợ PT/VCSH', 'Nợ vay/VCSH'], peerRows, { highlightFirst: true })}
${industryUsed ? `<p class="note">Nhóm so sánh lấy từ phân ngành: ${escapeHtml(industryUsed)}. Vốn hóa = giá đóng cửa x số cổ phiếu đang lưu hành.</p>` : ''}
${skippedPeers.length ? `<p class="note">Không dùng được: ${skippedPeers.map(s => escapeHtml(s.ticker)).join(', ')} (không có báo cáo quý gần đây trong mô hình báo cáo phi tài chính: có thể là ngân hàng, công ty chứng khoán, bảo hiểm hoặc đã ngừng công bố).</p>` : ''}

<h2>Công thức</h2>
<ul class="plain">${FORMULAS.map(([name, text]) => `<li><b>${escapeHtml(name)}</b>: ${escapeHtml(text)}</li>`).join('')}</ul>
${notes.length ? `<h2>Ghi chú và giới hạn</h2><ul class="plain">${notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}

<h2>Nguồn dữ liệu</h2>
<p class="note">Số liệu đọc từ API công khai finfo của VNDirect (không chính thức, có thể thay đổi hoặc chậm so với bản công bố gốc). Đối chiếu với báo cáo tài chính công bố của doanh nghiệp trước khi trích dẫn.</p>
${table(['Dữ liệu', 'URL'], sources.map(s => [s.label, { html: `<a href="${escapeHtml(s.url)}">${escapeHtml(s.url)}</a>` }]))}
<p class="note">${escapeHtml(DISCLAIMER)}</p>
</main></body></html>
`
}
