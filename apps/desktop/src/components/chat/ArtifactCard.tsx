import { useState } from 'react';
import { Download, File, Paperclip } from 'lucide-react';
import type { MediaAsset } from '@aria/shared';
import { desktop, errorMessage } from '../../services/desktop';
import { setChatAttachments } from '../../stores/chatStore';
import { Button } from '../ui';

export function ArtifactCard({
  asset,
  conversation,
  reusable,
}: {
  asset: MediaAsset;
  conversation: string;
  reusable: boolean;
}) {
  const [preview, setPreview] = useState('');
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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

  return (
    <figure className="media-preview">
      <figcaption>
        <File size={14} aria-hidden="true" /> {asset.name} · {(asset.size / 1000000).toFixed(2)} MB
      </figcaption>
      {removed ? (
        <p>File removed</p>
      ) : (
        <div className="media-actions">
          {asset.mimeType !== 'application/zip' && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void perform(async () =>
                  setPreview(
                    preview ? '' : await desktop().previewDocument(conversation, asset.id),
                  ),
                )
              }
            >
              {preview ? 'Hide preview' : 'Preview'}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void perform(() => desktop().exportMedia(asset.id))}
          >
            <Download size={13} /> Save file
          </Button>
          {asset.managed && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (confirm(`Remove the generated file “${asset.name}”?`))
                  void perform(async () => {
                    await desktop().removeArtifact(conversation, asset.id);
                    setRemoved(true);
                  });
              }}
            >
              Remove file
            </Button>
          )}
          {reusable && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setChatAttachments([asset], conversation);
                window.dispatchEvent(new Event('aria:focus-chat'));
              }}
            >
              <Paperclip size={13} /> Attach to draft
            </Button>
          )}
        </div>
      )}
      {preview && !removed && <pre className="document-passage">{preview}</pre>}
      {error && <p role="alert">{error}</p>}
    </figure>
  );
}
