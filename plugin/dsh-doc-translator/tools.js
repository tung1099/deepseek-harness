/**
 * `doc_translate` tool for the document-translator preset.
 *
 * One call translates a file and writes the result next to it: Word,
 * PowerPoint and Excel files are edited in place so fonts, sizes, colours,
 * tables and images stay as they are; scanned PDFs and images are read with
 * OCR models and the translation is drawn over the old text. The translation
 * runs inside the tool, in parallel batches over the configured models, so
 * the agent's own context never carries the document text.
 *
 * @module dsh-doc-translator/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { createLlm } from './llm.js'
import { SUPPORTED_EXTENSIONS } from './ooxml.js'
import { SCAN_EXTENSIONS } from './scan.js'
import { translateDocument, validateConfig } from './translate-file.js'

export const name = 'doc-translator-tools'
export const inject = ['tools', 'fs', 'workingDirectory']

export const Config = Schema.object({
  baseUrl: Schema.string().required()
    .description('Root of the OpenAI-compatible endpoint that serves the translation and OCR models, for example https://host/v1.'),
  apiKeyEnv: Schema.string()
    .description('Name of the environment variable that holds the API key. Leave unset for an endpoint that needs none.'),
  requestTimeoutMs: Schema.natural().min(1000).default(50_000)
    .description('Timeout of one model request. Keep it below any gateway limit in front of the endpoint (60 seconds on the staging gateway).'),
  retries: Schema.natural().max(5).default(2)
    .description('Extra attempts after a connection error, a timeout or an HTTP 429, 500, 502, 503 or 504.'),
  retryDelayMs: Schema.natural().default(500)
    .description('Wait before each retry, multiplied by the attempt number.'),
  translationModels: Schema.array(Schema.string()).required()
    .description('Models that translate, in order of preference. Batches are spread over them in turn; a model that fails hands its batch to the next one.'),
  modelConcurrency: Schema.dict(Schema.natural().min(1)).default({})
    .description('Most requests in flight at once for a model, by model id. Models not listed use defaultConcurrency.'),
  defaultConcurrency: Schema.natural().min(1).default(4)
    .description('Requests in flight at once for a model without its own limit.'),
  batchConcurrency: Schema.natural().min(1).default(6)
    .description('Translation batches in flight at once across all models.'),
  batchChars: Schema.natural().min(200).default(2500)
    .description('Source characters in one translation batch.'),
  batchItems: Schema.natural().min(1).default(40)
    .description('Lines in one translation batch.'),
  maxOutputTokens: Schema.natural().min(256).default(4096)
    .description('Token limit of one translation reply.'),
  maxFileBytes: Schema.natural().min(1).default(50 * 1024 * 1024)
    .description('Largest input file.'),
  maxArchiveBytes: Schema.natural().min(1).default(300 * 1024 * 1024)
    .description('Largest total uncompressed size of an Office package; protects against zip bombs.'),
  expansionWarn: Schema.number().min(1).default(1.5)
    .description('Report lines whose translation is at least this many times as long as the source.'),
  verifyLayout: Schema.boolean().default(true)
    .description('Render Office files with LibreOffice before and after and compare page counts. Needs soffice and pdfinfo; a missing program only skips the check.'),
  ocr: Schema.object({
    spotModel: Schema.string().required().description('Model that returns each text line with its position (PaddleOCR-VL with the "Spotting:" prompt).'),
    readModel: Schema.string().required().description('Model that reads the page text accurately; its text replaces the text of the position model line by line.'),
    dpi: Schema.natural().min(72).max(400).default(150).description('Resolution of the page images made from a PDF.'),
    maxPages: Schema.natural().min(1).default(30).description('Most pages in one scanned PDF.'),
    pageConcurrency: Schema.natural().min(1).default(4).description('Pages read at once.'),
    useTextLayer: Schema.boolean().default(true).description('Read the text of a PDF page from its text layer when it has one, instead of OCR. The text is exact and the font family, size, colour and weight come from the PDF.'),
    minLayerLetters: Schema.natural().min(1).default(20).description('A PDF page with fewer letters than this in its text layer is treated as an image and read with OCR.'),
  }).required().description('OCR models and page limits for scanned files.'),
  toolTimeoutMs: Schema.natural().min(1000).default(900_000)
    .description('Time budget of one doc_translate call.'),
}).description('Document translator settings.')

const OUTPUT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    file: { type: 'string', required: true },
    text: { type: 'string', required: true },
  },
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  validateConfig(config)
  // Same condition `dsh-tool-fs` uses: the policy service matters only when a confining filesystem is mounted.
  const sandboxPolicy = ctx.fs.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy')
  const llm = createLlm({
    baseUrl: config.baseUrl,
    apiKeyEnv: config.apiKeyEnv,
    timeoutMs: config.requestTimeoutMs,
    retries: config.retries,
    retryDelayMs: config.retryDelayMs,
    defaultConcurrency: config.defaultConcurrency,
    concurrency: config.modelConcurrency,
  })

  ctx.tools.register(defineTool({
    name: 'doc_translate',
    description: 'Translate a file into another language and save the result next to it. '
      + `Word, PowerPoint and Excel files (${SUPPORTED_EXTENSIONS.map(e => `.${e}`).join(', ')}) keep their fonts, sizes, colours, tables and images: only the text changes. `
      + `PDFs and images (${SCAN_EXTENSIONS.map(e => `.${e}`).join(', ')}): a PDF page with a text layer is read exactly from it, any other page with OCR; the translation is drawn over the old text, and the output is an image or an image-only PDF whose text cannot be selected. `
      + 'The old binary formats .doc, .xls and .ppt are not supported. The translation runs inside the tool, so you never read or write the document text yourself. '
      + 'The result says what was checked and what changed; report only that. Call present on the output file afterwards.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path of the file, relative to the working directory or absolute.' },
      target_language: { type: 'string', required: true, description: 'Language to translate into, for example "English", "Vietnamese" or "Japanese".' },
      source_language: { type: 'string', description: 'Language of the file. Omit to let the model detect it.' },
      glossary: {
        type: 'array',
        description: 'Terms that must be translated a fixed way.',
        items: { type: 'object', additionalProperties: false, properties: { source: { type: 'string', required: true }, target: { type: 'string', required: true } } },
      },
      verify_layout: { type: 'boolean', description: 'Office files only: render before and after with LibreOffice and compare page counts. Default true.' },
    },
    output: {
      schema: OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: config.toolTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('doc_translate requires an agent Session with a working directory')
      return await translateDocument({ ctx, sandboxPolicy, exec, args, config, llm })
    },
  }))
}
