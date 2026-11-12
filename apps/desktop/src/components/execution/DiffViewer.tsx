import type { FileChange } from '@aria/shared';
import { CopyButton } from '../ui';
export default function DiffViewer({ change }: { change: FileChange }) {
  return (
    <div className="diff-viewer">
      <div className="code-toolbar">
        <code title={change.path}>{change.path}</code>
        <CopyButton text={change.path} label="Copy file path" />
      </div>
      {change.kind === 'read' ? (
        <pre>{change.before}</pre>
      ) : (
        <div className="diff-columns">
          <div>
            <div className="diff-label">
              Before <CopyButton text={change.before} label="Copy original content" />
            </div>
            <pre className="diff-before">{change.before || '(empty file)'}</pre>
          </div>
          <div>
            <div className="diff-label">
              After <CopyButton text={change.after} label="Copy updated content" />
            </div>
            <pre className="diff-after">{change.after || '(deleted file)'}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
