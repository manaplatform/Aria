import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CommandOutput } from '@aria/shared';
import { CopyButton } from '../ui';
import { outputLines } from '../../services/output';
export default function TerminalOutput({ output }: { output: CommandOutput[] }) {
  const [stream, setStream] = useState('all');
  const [search, setSearch] = useState('');
  const parent = useRef<HTMLDivElement>(null);
  const lines = useMemo(
    () =>
      outputLines(output.filter((chunk) => stream === 'all' || chunk.stream === stream)).filter(
        (line) => !search || line.text.toLowerCase().includes(search.toLowerCase()),
      ),
    [output, stream, search],
  );
  const virtual = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 20,
    overscan: 12,
  });
  const maxLength = useMemo(
    () => lines.reduce((length, line) => Math.max(length, line.text.length), 40),
    [lines],
  );
  return (
    <div className="terminal-output">
      <div className="terminal-tools">
        <select
          aria-label="Output stream"
          value={stream}
          onChange={(event) => setStream(event.target.value)}
        >
          <option value="all">All output</option>
          <option value="stdout">stdout</option>
          <option value="stderr">stderr</option>
        </select>
        <input
          aria-label="Search output"
          placeholder="Find in output…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <span className="muted">{lines.length} lines</span>
        <CopyButton text={output.map((chunk) => chunk.text).join('')} label="Copy exact output" />
      </div>
      <div
        ref={parent}
        className="terminal-scroll"
        tabIndex={0}
        aria-label="Terminal output"
        role="log"
      >
        <div
          style={{
            height: virtual.getTotalSize(),
            minWidth: maxLength * 7.3 + 20,
            position: 'relative',
          }}
        >
          {virtual.getVirtualItems().map((row) => {
            const line = lines[row.index];
            return (
              <div
                key={line.key}
                className={`terminal-line ${line.stream === 'stderr' ? 'stderr' : ''}`}
                style={{ position: 'absolute', top: row.start, height: 20 }}
              >
                <span className="sr-only">{line.stream}: </span>
                {line.text || ' '}
              </div>
            );
          })}
        </div>
        {!lines.length && <p className="muted terminal-empty">No matching output.</p>}
      </div>
    </div>
  );
}
