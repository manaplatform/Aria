import {
  containsSecret,
  presentationBlockSchema,
  presentationCell,
  presentationInputSchema,
  presentationFence,
  presentationLimits,
  updatePresentation,
  type PresentationPart,
  weatherResult,
} from '@aria/shared';
import { z } from 'zod';
import type { Outcome } from './execution-engine';

export const presentationPrompt = [
  'Keep ordinary Markdown and LaTeX available. For useful interactive elements emit prose and top-level blocks fenced with three backticks and aria-ui, starting after a blank line. Close each block before continuing prose. Summarize the takeaway in prose. Use a compact JSON object with v:1, id, revision:1, roots:[node IDs], nodes:[{id,type,label?,...}]. A higher revision can update a block by using the same ID at its original position. Keep node IDs stable.',
  'Nodes: text, heading, markdown, code, math, badge and callout use text; list uses items and optional ordered; divider and icon are available. Layout types card,row,column,grid,tabs,section,comparison use children:[node IDs]. Label tabs and layouts as needed.',
  'Tables and charts use dataset ID. Table supports sortable and filterable. Chart uses chart:bar|line|pie|scatter (category column then numeric columns; scatter uses two numeric columns). Metric and progress use dataset, zero-based row and column, optional unit. Use datasets:[{id,columns,data:{kind:"user",quote:"exact JSON array of rows or exact tab-separated/comma-separated rows"} }]. For a completed tool result use data:{kind:"result",stepId,path:[keys or indexes in result.data],keys?:[object row keys]}. Illustrative datasets use data:{kind:"illustrative",rows} and must be clearly described as illustrative. Never represent invented data as observed.',
  'Diagram uses kind:svg|flowchart|architecture|dependency|sequence|timeline|tree, description, nodes:[{id,label,group?}], edges:[{from,to,label?}]. Status uses real stepId. Sources are real source UUIDs already returned to you. Use only observed relationships for factual diagrams.',
  'For a useful weather display, use a weather node with stepId from a completed weather capability and view:current|hourly|daily|forecast|comparison. Do not supply data; Aria binds the verified result. Simple questions can use ordinary prose.',
  'Form and calculator use fields:[{id,label,kind:checkbox|text|date|select|slider,value?,options?,min?,max?,step?}]. Calculator accepts expression with numeric field placeholders such as "{amount} * 1.1". Form may reference a followUp action. Button uses action ID. Define actions:[{id,label,kind:"followUp",request}, {id,label,kind:"copy"|"export",target:nodeID}, {id,label,kind:"link",sourceId}, or {id,label,kind:"approval",stepId}]. A follow-up opens a request for the user to review. Approval buttons refer to an existing approval. Keep secrets, credentials, private URLs and unnecessary personal data out of blocks.',
].join('\n');

type Provenance = {
  latest: string;
  outcome(id: string): Outcome | undefined;
  hasStep(id: string): boolean;
  hasSource(id: string): boolean;
  hasWeatherStep?(id: string): boolean;
};
const table = z
  .array(z.array(presentationCell).min(1).max(presentationLimits.columns))
  .min(1)
  .max(presentationLimits.rows);

function parseQuotedRows(quote: string) {
  if (quote.trimStart().startsWith('[')) return JSON.parse(quote);
  const parseCell = (value: string) => {
    const cell = value.trim();
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(cell)) return Number(cell);
    return cell;
  };
  // Quoted CSV fields stay in JSON or TSV. Simple comma-delimited rows need no quoting.
  const delimiter = quote.includes('\t') ? '\t' : ',';
  return quote
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(delimiter).map(parseCell));
}

function publicLink(url: string) {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function resolveBlock(body: string, provenance: Provenance) {
  const block = presentationInputSchema.parse(JSON.parse(body));
  if (block.sources?.some((id) => !provenance.hasSource(id))) throw new Error('Invalid source.');
  for (const action of block.actions ?? []) {
    if (
      action.kind === 'link' &&
      (action.sourceId
        ? !provenance.hasSource(action.sourceId)
        : !action.url ||
          !publicLink(action.url) ||
          !provenance.latest.split(/\s+/u).includes(action.url))
    )
      throw new Error('Invalid link.');
    if (action.kind === 'approval' && !provenance.hasStep(action.stepId))
      throw new Error('Invalid step.');
  }
  if (block.nodes.some((node) => node.type === 'status' && !provenance.hasStep(node.stepId)))
    throw new Error('Invalid step.');
  const nodes = block.nodes.map((node) => {
    if (node.type !== 'weather') return node;
    if (node.data || !provenance.hasWeatherStep?.(node.stepId)) throw new Error('Weather data must come from an observed weather result.');
    const outcome = provenance.outcome(node.stepId);
    const data = weatherResult.safeParse(outcome?.data);
    if (outcome?.status !== 'completed' || !data.success || (!('provider' in data.data) && !('results' in data.data)))
      throw new Error('Invalid weather result.');
    return { ...node, data: data.data };
  });
  const datasets = block.datasets?.map(({ id, columns, data }) => {
    if (data.kind === 'illustrative') return { id, columns, rows: data.rows, illustrative: true };
    if (data.kind === 'user') {
      if (!provenance.latest.includes(data.quote)) throw new Error('Invalid user data.');
      return { id, columns, rows: table.parse(parseQuotedRows(data.quote)), illustrative: false };
    }
    const outcome = provenance.outcome(data.stepId);
    if (outcome?.status !== 'completed') throw new Error('Invalid result.');
    let value: unknown = outcome.data;
    for (const key of data.path) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key))
        throw new Error('Invalid data path.');
      value = (value as Record<string | number, unknown>)[key];
    }
    if (data.keys && Array.isArray(value) && value.length <= presentationLimits.rows) {
      const keys = data.keys;
      value = value.map((row: unknown) =>
        keys.map((key) => {
          if (!row || typeof row !== 'object' || !Object.hasOwn(row, key))
            throw new Error('Invalid row.');
          return (row as Record<string, unknown>)[key];
        }),
      );
    }
    return { id, columns, rows: table.parse(value), illustrative: false, stepId: data.stepId };
  });
  const projected = presentationBlockSchema.parse({ ...block, nodes, datasets });
  if (containsSecret(JSON.stringify(projected))) throw new Error('Sensitive presentation data.');
  return projected;
}

const openings = ['```', '~~~'].map((marker) => marker + presentationFence);
const ordinaryFence = /^ {0,3}(`{3,}|~{3,})[^\n]*$/;

/** Incremental line parser. Forward ordinary prose as soon as it cannot be a reserved fence. */
export class PresentationOutput {
  private line = '';
  private ordinary: string | undefined;
  private marker: string | undefined;
  private body = '';
  private oversized = false;
  private blank = true;
  private passed = false;
  private offset = 0;
  private updates = 0;
  private bytes = 0;
  private parts: PresentationPart[] = [];
  private notice = 0;

  constructor(
    private readonly provenance: Provenance,
    private readonly text: (text: string) => void,
    private readonly present: (part: PresentationPart) => void,
    private readonly report: (ok: boolean, durationMs: number) => void,
  ) {}

  append(chunk: string) {
    for (const piece of chunk.match(/[^\n]*\n|[^\n]+/g) ?? []) {
      const complete = piece.endsWith('\n');
      const value = complete ? piece.slice(0, -1) : piece;
      if (this.marker && this.line.length + value.length > presentationLimits.bytes)
        this.oversized = true;
      if (this.oversized && this.marker) this.line = (this.line + value).slice(0, 64);
      else if (!this.passed) this.line += value;
      if (this.passed) this.send(piece);
      else if (complete) this.endLine('\n');
      else if (
        !this.marker &&
        !this.ordinary &&
        !/^ {0,3}(?:`*|~*)\r?$/.test(this.line) &&
        !/^ {0,3}[`~]{3}/.test(this.line) &&
        !openings.some((opening) => opening.startsWith(this.line))
      ) {
        this.send(this.line);
        this.line = '';
        this.passed = true;
      }
      if (complete) {
        if (this.passed) this.blank = false;
        this.line = '';
        this.passed = false;
      }
    }
  }

  private send(value: string) {
    if (!value) return;
    this.offset += value.length;
    this.text(value);
  }

  private endLine(newline: string) {
    const line = this.line.replace(/\r$/, '');
    if (this.marker) {
      if (line.trimEnd() === this.marker) {
        this.accept();
        this.marker = undefined;
        this.body = '';
        this.oversized = false;
        this.blank = true;
      } else if (!this.oversized) {
        this.body += this.line + newline;
        if (this.body.length > presentationLimits.bytes) {
          this.oversized = true;
          this.body = '';
        }
      }
      return;
    }
    const fence = ordinaryFence.exec(line)?.[1];
    if (!this.ordinary && this.blank && openings.includes(line.trimEnd())) {
      this.marker = line.slice(0, 3);
      return;
    }
    if (
      this.ordinary &&
      line.trim().startsWith(this.ordinary) &&
      [...line.trim()].every((char) => char === this.ordinary![0])
    )
      this.ordinary = undefined;
    else if (!this.ordinary && fence) this.ordinary = fence;
    this.blank = line.trim() === '';
    this.send(this.line + newline);
  }

  private publish(part: PresentationPart) {
    const next = updatePresentation(this.parts, part);
    if (next === this.parts) return false;
    this.parts = next;
    this.present(part);
    return true;
  }

  private unavailable(durationMs = 0) {
    this.report(false, durationMs);
    this.publish({ kind: 'unavailable', offset: this.offset, id: 'unavailable-' + ++this.notice });
  }

  private accept() {
    this.bytes += Buffer.byteLength(this.body);
    if (++this.updates > presentationLimits.updates || this.bytes > presentationLimits.bytes)
      return;
    const started = performance.now();
    try {
      if (this.oversized) throw new Error('Block limit exceeded.');
      const block = resolveBlock(this.body, this.provenance);
      const accepted = this.publish({ kind: 'block', offset: this.offset, block });
      if (accepted) this.report(true, performance.now() - started);
    } catch {
      this.unavailable(performance.now() - started);
    }
  }

  finish() {
    if (this.line) this.endLine('');
    if (this.marker) this.unavailable();
    this.line = '';
    this.marker = undefined;
    this.body = '';
  }
}
