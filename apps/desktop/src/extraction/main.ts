/// <reference types="vite/client" />
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { configure, Uint8ArrayReader, ZipReader } from '@zip.js/zip.js';
import { SaxesParser } from 'saxes';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import type { DocumentEvidence } from '@aria/shared';

type Location = NonNullable<DocumentEvidence['location']>;
type Passage = { text: string; location?: Location };
const outputLimit = 1_000_000;
const pdfPageLimit = 300;
const zipEntryLimit = 1500;
const expandedZipLimit = 48_000_000;
GlobalWorkerOptions.workerSrc = pdfWorker;
configure({ useWebWorkers: false });

function bound(passages: Passage[]) {
  if (passages.reduce((sum, { text }) => sum + text.length, 0) > outputLimit)
    throw new Error('Extracted text exceeds the document limit.');
  return passages;
}

async function pdf(data: Uint8Array<ArrayBuffer>) {
  const loading = getDocument({ data, enableXfa: false, useWasm: false, useSystemFonts: false });
  try {
    const document = await loading.promise;
    if (document.numPages > pdfPageLimit) throw new Error('The PDF exceeds the 300 page limit.');
    const result: Passage[] = [];
    for (let page = 1; page <= document.numPages; page++) {
      const current = await document.getPage(page);
      try {
        const { items } = await current.getTextContent();
        result.push({
          text: items
            .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
            .join(''),
          location: { kind: 'page', start: page, end: page },
        });
        bound(result);
      } finally {
        current.cleanup();
      }
    }
    if (!result.some(({ text }) => text.trim()))
      throw new Error('This PDF has no extractable text. A scanned PDF requires OCR.');
    return result;
  } finally {
    await loading.destroy();
  }
}

async function xmlEntry(entry: {
  getData: (
    writer: WritableStream<Uint8Array>,
    options?: { checkSignature?: boolean },
  ) => Promise<unknown>;
}) {
  const parts: Uint8Array[] = [];
  let size = 0;
  await entry.getData(
    new WritableStream<Uint8Array>({
      write(part) {
        size += part.length;
        if (size > 8_000_000)
          throw new Error('An Office XML part exceeds the decompression limit.');
        parts.push(part.slice());
      },
    }),
    { checkSignature: true },
  );
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return parts.map((part) => decoder.decode(part, { stream: true })).join('') + decoder.decode();
}

function parseOfficeXml(
  xml: string,
  mode: 'word' | 'slide' | 'sheet' | 'shared',
  strings: string[] = [],
) {
  const parser = new SaxesParser({ xmlns: true });
  const output: string[] = [];
  let active = false;
  let text = '';
  let type = '';
  parser.on('doctype', () => {
    throw new Error('Office document types and external entities are unsupported.');
  });
  parser.on('opentag', (tag) => {
    const element = tag.local;
    if (mode === 'sheet' && element === 'c') type = tag.attributes.t?.value ?? '';
    active ||= element === 't' || (mode === 'sheet' && element === 'v');
  });
  parser.on('text', (part) => {
    if (active) text += part;
  });
  parser.on('closetag', (tag) => {
    const element = tag.local;
    if (element === 't' || element === 'v') active = false;
    if (
      (mode === 'sheet' && element === 'c') ||
      (mode === 'shared' && element === 'si') ||
      ((mode === 'word' || mode === 'slide') && element === 'p')
    ) {
      output.push(mode === 'sheet' && type === 's' ? (strings[Number(text)] ?? '') : text);
      text = '';
    }
    if (mode === 'sheet' && element === 'row') output.push('\n');
  });
  parser.write(xml).close();
  return output;
}

async function office(data: Uint8Array<ArrayBuffer>, extension: string): Promise<Passage[]> {
  const zip = new ZipReader(new Uint8ArrayReader(data));
  try {
    const entries = await zip.getEntries();
    if (
      entries.length > zipEntryLimit ||
      entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > expandedZipLimit
    )
      throw new Error('The Office document exceeds the archive limits.');
    if (
      !entries.some((entry) => entry.filename === '[Content_Types].xml') ||
      entries.some(
        (entry) => entry.encrypted || /vbaProject|\/embeddings\//i.test(entry.filename),
      ) ||
      new Set(entries.map((entry) => entry.filename)).size !== entries.length
    )
      throw new Error('Unsupported or invalid Office document structure.');
    if (extension === '.xlsx') {
      const shared = entries.find((entry) => entry.filename === 'xl/sharedStrings.xml');
      const strings =
        shared && !shared.directory ? parseOfficeXml(await xmlEntry(shared), 'shared') : [];
      const result: Passage[] = [];
      for (const entry of entries) {
        const sheet = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(entry.filename);
        if (sheet && !entry.directory) {
          const sheetId = Number(sheet[1]);
          result.push({
            text: parseOfficeXml(await xmlEntry(entry), 'sheet', strings)
              .join('\t')
              .replace(/\t*\n\t*/g, '\n'),
            location: {
              kind: 'sheet',
              start: sheetId,
              end: sheetId,
              label: `Worksheet part ${sheetId}`,
            },
          });
          bound(result);
        }
      }
      return result;
    }
    const result: Passage[] = [];
    for (const entry of entries) {
      if (entry.directory) continue;
      if (extension === '.docx' && entry.filename === 'word/document.xml')
        result.push({ text: parseOfficeXml(await xmlEntry(entry), 'word').join('\n') });
      const slide = /^ppt\/slides\/slide(\d+)\.xml$/.exec(entry.filename);
      if (extension === '.pptx' && slide) {
        const slideId = Number(slide[1]);
        result.push({
          text: parseOfficeXml(await xmlEntry(entry), 'slide').join('\n'),
          location: { kind: 'slide', start: slideId, end: slideId, label: `Slide part ${slideId}` },
        });
      }
      bound(result);
    }
    return result;
  } finally {
    await zip.close();
  }
}

function html(bytes: Uint8Array) {
  const queue: DefaultTreeAdapterTypes.Node[] = [
    parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  ];
  const fragments: string[] = [];
  while (queue.length) {
    const node = queue.pop()!;
    if ('tagName' in node && ['script', 'style', 'template'].includes(node.tagName)) continue;
    if ('value' in node) fragments.push(node.value);
    if ('childNodes' in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--) queue.push(node.childNodes[i]);
  }
  return bound([{ text: fragments.join(' ') }]);
}

Object.assign(window, {
  async embedDocuments(texts: string[]) {
    return (await import('./embeddings')).embed(texts);
  },
  extractDocument(base64: string, extension: string) {
    return (async () => {
      try {
        const data = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
        const passages =
          extension === '.pdf'
            ? await pdf(data)
            : extension === '.html'
              ? html(data)
              : await office(data, extension);
        return { passages };
      } catch (error) {
        return {
          error:
            error instanceof Error ? error.message.slice(0, 300) : 'Document extraction failed.',
        };
      }
    })();
  },
});
