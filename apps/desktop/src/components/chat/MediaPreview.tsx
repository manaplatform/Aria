import { useState } from 'react';
import { Download, ImagePlus } from 'lucide-react';
import type { MediaAsset } from '@aria/shared';
import { desktop, errorMessage } from '../../services/desktop';
import { setChatAttachments } from '../../stores/chatStore';
import { Button } from '../ui';
export function MediaPreview({
  asset,
  reusable = false,
}: {
  asset: MediaAsset;
  reusable?: boolean;
}) {
  const [error, setError] = useState('');
  const source = `aria-media://asset/${encodeURIComponent(asset.id)}`;
  return (
    <figure className="media-preview">
      {!error &&
        (asset.mimeType.startsWith('image/') ? (
          <img
            src={source}
            alt={asset.name}
            loading="lazy"
            onError={() => setError('This media file is missing or unreadable.')}
          />
        ) : (
          <audio
            controls
            preload="metadata"
            src={source}
            aria-label={asset.name}
            onError={() => setError('This media file is missing or unreadable.')}
          />
        ))}
      <figcaption>
        {asset.name} · {(asset.size / 1000000).toFixed(2)} MB
      </figcaption>
      {error && (
        <p className="chat-response-error" role="alert">
          {error}
        </p>
      )}
      <div className="media-actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void desktop()
              .exportMedia(asset.id)
              .catch((failure) => setError(errorMessage(failure)));
          }}
        >
          <Download size={13} />
          Download
        </Button>
        {reusable && asset.mimeType.startsWith('image/') && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setChatAttachments([asset]);
              window.dispatchEvent(new Event('aria:edit-image'));
            }}
          >
            <ImagePlus size={13} />
            Use image
          </Button>
        )}
      </div>
    </figure>
  );
}
