import type { CommandOutput } from '@aria/shared';
export interface OutputLine {
  key: string;
  text: string;
  stream: CommandOutput['stream'];
}
// Adjacent chunks may split a line at any byte boundary. Do not invent newlines.
export function outputLines(output: CommandOutput[]): OutputLine[] {
  const lines: OutputLine[] = [];
  let partial: OutputLine | undefined;
  for (const chunk of output) {
    if (partial && partial.stream !== chunk.stream) partial = undefined;
    const segments = chunk.text.split('\n');
    segments.forEach((text, index) => {
      if (!partial) {
        partial = { key: `${chunk.id}-${index}`, text: '', stream: chunk.stream };
        lines.push(partial);
      }
      partial.text += text;
      if (index < segments.length - 1) partial = undefined;
    });
    if (chunk.text.endsWith('\n') && partial?.text === '') {
      lines.pop();
      partial = undefined;
    }
  }
  return lines;
}
