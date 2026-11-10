import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coreName, fold, listCompanies, scoreCompany, searchCompanies } from '../lookup.js'
import { renderMatches } from '../summary.js'
import { CONFIG, makeCompany, makeFetch } from './fixtures.js'

/** Names copied from the VNDirect list of listed companies. */
const LIST = [
  { code: 'FPT', companyName: 'Công ty Cổ phần FPT', shortName: 'FPT Corp', floor: 'HOSE' },
  { code: 'FRT', companyName: 'Công ty Cổ phần Bán lẻ Kỹ thuật số FPT', shortName: 'FPT Retail', floor: 'HOSE' },
  { code: 'HPG', companyName: 'Công ty Cổ phần Tập đoàn Hòa Phát', shortName: 'Hòa Phát', floor: 'HOSE' },
  { code: 'HPA', companyName: 'Công ty cổ phần Tập đoàn Nông nghiệp Quốc tế Hòa Phát', floor: 'UPCOM' },
  { code: 'VNM', companyName: 'Công ty Cổ phần Sữa Việt Nam', shortName: 'Vinamilk', floor: 'HOSE' },
  { code: 'HNM', companyName: 'Công ty Cổ phần Sữa Hà Nội', floor: 'UPCOM' },
  { code: 'MWG', companyName: 'Công ty Cổ phần đầu tư Thế giới di động', floor: 'HOSE' },
  { code: 'NKG', companyName: 'Công ty Cổ phần Thép Nam Kim', floor: 'HOSE' },
  { code: 'HSG', companyName: 'Công ty Cổ phần Tập đoàn Hoa Sen', floor: 'HOSE' },
  { code: 'TLH', companyName: 'Công ty Cổ phần Tập đoàn Thép Tiến Lên', floor: 'HOSE' },
]

test('fold removes accents, maps đ to d and collapses punctuation', () => {
  assert.equal(fold('Hòa  Phát, Đầu-tư'), 'hoa phat dau tu')
  assert.equal(fold(null), '')
})

test('coreName drops leading legal-form words only', () => {
  assert.equal(coreName('Công ty Cổ phần Sữa Việt Nam'), 'sua viet nam')
  assert.equal(coreName('Công ty cổ phần Tập đoàn Hòa Phát'), 'hoa phat')
  assert.equal(coreName('Tập đoàn VINGROUP - CTCP'), 'vingroup ctcp')
  assert.equal(coreName('Ngân hàng Thương mại Cổ phần Ngoại thương Việt Nam'), 'ngoai thuong viet nam')
})

test('a stock code scores highest, regardless of case', () => {
  assert.equal(scoreCompany(LIST[0], 'fpt'), 100)
  assert.equal(scoreCompany(LIST[0], 'FPT'), 100)
})

test('a name matches with or without accents and legal prefixes', () => {
  for (const query of ['Hòa Phát', 'hoa phat', 'Tập đoàn Hòa Phát', 'công ty cổ phần tập đoàn hòa phát']) {
    assert.equal(searchCompanies(LIST, query, 5).matches[0].ticker, 'HPG', query)
  }
  assert.equal(scoreCompany(LIST[4], 'Vinamilk'), 90)
})

test('one exact match is confident even when other names contain the phrase', () => {
  const result = searchCompanies(LIST, 'Hòa Phát', 5)
  assert.equal(result.confident, true)
  assert.deepEqual(result.matches.map(m => m.ticker), ['HPG', 'HPA'])
  assert.equal(result.matches[0].score, 90)
  assert.equal(result.matches[1].score, 60)
})

test('a unique partial match is confident and a broad word is not', () => {
  assert.equal(searchCompanies(LIST, 'Thế giới di động', 5).confident, true)
  const broad = searchCompanies(LIST, 'Thép', 5)
  assert.equal(broad.confident, false)
  assert.equal(broad.total, 2)
  assert.deepEqual(broad.matches.map(m => m.ticker), ['NKG', 'TLH'])
})

test('a stock code query is confident although other names mention it', () => {
  const result = searchCompanies(LIST, 'FPT', 5)
  assert.equal(result.confident, true)
  assert.deepEqual(result.matches.map(m => [m.ticker, m.score]), [['FPT', 100], ['FRT', 60]])
})

test('ties are ordered by floor then code, and the limit applies', () => {
  const result = searchCompanies(LIST, 'Sữa', 1)
  assert.equal(result.matches.length, 1)
  assert.equal(result.total, 2)
  assert.equal(result.matches[0].ticker, 'VNM')
})

test('no match and a blank query give nothing and are not confident', () => {
  assert.deepEqual(searchCompanies(LIST, 'zzzz', 5), { matches: [], confident: false, total: 0 })
  assert.equal(searchCompanies(LIST, '   ', 5).total, 0)
})

test('listCompanies reads the listed companies in one request and returns the URL', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = makeFetch([makeCompany({ ticker: 'AAA', name: 'Công ty Cổ phần Alpha', shortName: 'Alpha' }), makeCompany({ ticker: 'BBB' })], { calls })
  try {
    const { companies, sourceUrl } = await listCompanies(CONFIG, new AbortController().signal)
    assert.deepEqual(companies.map(c => c.code), ['AAA', 'BBB'])
    assert.equal(calls.length, 1)
    assert.equal(sourceUrl, calls[0])
    assert.match(sourceUrl, /stocks\?q=type:STOCK~status:listed/)
    assert.equal(searchCompanies(companies, 'alpha', 5).matches[0].ticker, 'AAA')
  } finally { globalThis.fetch = original }
})

test('the digest tells the model what to do next in each case', () => {
  const url = 'https://x/v4/stocks?q=a'
  const sure = renderMatches('Hòa Phát', searchCompanies(LIST, 'Hòa Phát', 5), url)
  assert.match(sure, /1\. HPG - Công ty Cổ phần Tập đoàn Hòa Phát \(Hòa Phát\), HOSE \[company name\]/)
  assert.match(sure, /2\. HPA .*\[partial name\]/)
  assert.match(sure, /Confident: yes\. HPG is the only exact match\. Use it now with fin_report/)
  const unsure = renderMatches('Thép', searchCompanies(LIST, 'Thép', 1), url)
  assert.match(unsure, /1 more match\(es\) not shown/)
  assert.match(unsure, /Confident: no\. Ask the user which company they mean with ask_user_question/)
  const none = renderMatches('zzzz', searchCompanies(LIST, 'zzzz', 5), url)
  assert.match(none, /None\. Ask the user for the stock code or the registered company name/)
})
