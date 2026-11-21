import { useEffect, useState } from 'react';
import type { DocumentEvidence as Evidence } from '@aria/shared';
import { desktop, errorMessage } from '../../services/desktop';
import { Button } from '../ui';

export function DocumentEvidence({
  conversation,
  evidence,
  selected,
  onSelect,
}: {
  conversation: string;
  evidence: Evidence[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [passage, setPassage] = useState<Evidence>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!selected || !evidence.some((item) => item.id === selected)) return;
    let active = true;
    setError('');
    setPassage(undefined);
    setPending(true);
    void desktop()
      .documentEvidence(conversation, selected)
      .then((result) => {
        if (active) setPassage(result);
      })
      .catch((failure) => {
        if (active) setError(errorMessage(failure));
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [conversation, selected, evidence]);
  return (
    <section className="conductor-sources" aria-label="Document evidence">
      {evidence.map((item) => (
        <Button
          key={item.id}
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => onSelect(item.id)}
        >
          {item.name}
          {item.location?.label
            ? ` · ${item.location.label}`
            : item.location?.kind === 'page'
              ? ` · page ${item.location.start}`
              : ''}
        </Button>
      ))}
      {selected && passage?.id === selected && (
        <blockquote className="document-passage">{passage.excerpt}</blockquote>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
