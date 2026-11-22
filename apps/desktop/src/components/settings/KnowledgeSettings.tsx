import { useEffect, useState } from 'react';
import type { DesktopBridge, KnowledgeCollection } from '@aria/shared';
import { desktop, errorMessage } from '../../services/desktop';
import { Button } from '../ui';

export function KnowledgeSettings() {
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [name, setName] = useState('');
  const [installed, setInstalled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    void Promise.resolve()
      .then(() => Promise.all([desktop().knowledgeCollections(), desktop().localEmbeddings()]))
      .then(([libraries, available]) => {
        if (mounted) {
          setCollections(libraries);
          setInstalled(available);
        }
      })
      .catch((failure) => {
        if (mounted) setError(errorMessage(failure));
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  function change(input: Parameters<DesktopBridge['manageKnowledge']>[0]) {
    return perform(async () => {
      setCollections(await desktop().manageKnowledge(input));
      if (input.operation === 'create') setName('');
    });
  }

  return (
    <section className="settings-section" id="knowledge">
      <h2>Knowledge libraries</h2>
      <p className="muted">
        Add documents and enable a library to make it available to chat. Documents are indexed on
        the first search.
      </p>
      <div className="shortcut-row">
        <input
          aria-label="New knowledge library name"
          value={name}
          disabled={busy}
          maxLength={100}
          placeholder="Library name"
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          size="sm"
          disabled={busy || !name.trim()}
          onClick={() => void change({ operation: 'create', name })}
        >
          Create library
        </Button>
      </div>
      {collections.map((item) => (
        <details key={item.id} className="conductor-activity">
          <summary>
            {item.name} · {item.files.length} documents
          </summary>
          <div className="shortcut-row">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void change({ operation: 'enable', id: item.id, enabled: !item.enabled })
              }
            >
              {item.enabled ? 'Disable in chat' : 'Enable in chat'}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void change({ operation: 'add', id: item.id })}
            >
              Add documents
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (confirm(`Remove the library “${item.name}” and its imported copies?`))
                  void change({ operation: 'remove', id: item.id });
              }}
            >
              Remove library
            </Button>
          </div>
          {item.files.map((file) => (
            <div className="shortcut-row" key={file.id}>
              <span>
                {file.name} · {file.status === 'ready' ? 'Indexed' : 'Ready to index'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (confirm(`Remove “${file.name}” from this library?`))
                    void change({ operation: 'remove-file', id: item.id, fileId: file.id });
                }}
              >
                Remove file
              </Button>
            </div>
          ))}
        </details>
      ))}
      <div className="shortcut-row">
        <span>
          {installed
            ? 'Local semantic and hybrid search enabled'
            : 'Keyword and phrase search enabled'}
        </span>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              if (installed) {
                await desktop().removeLocalEmbeddings();
                setInstalled(false);
              } else setInstalled(await desktop().installLocalEmbeddings());
            })
          }
        >
          {installed ? 'Remove embedding pack' : 'Install local embedding pack'}
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
