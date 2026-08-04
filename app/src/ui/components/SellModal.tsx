/**
 * "Sell / export listing" modal: drafts marketplace copy for one item
 * (AI-written when a Claude key is on this device, field template otherwise),
 * lets the user tweak it, then hands it off to the Peerventory Chrome
 * extension as a JSON payload plus downloaded photos. See connector/README.md
 * for the payload contract and the autofill workflow.
 */

import { useEffect, useRef, useState } from 'react';
import { getAiKey } from '../../services';
import type { Item } from '../../types';
import {
  buildAiDraft,
  buildPayload,
  buildTemplateDraft,
  downloadListingPhotos,
  payloadJson,
  payloadText,
} from '../lib/listing';
import type { ListingDraft } from '../lib/listing';
import { copyToClipboard } from '../lib/links';
import { Modal } from './Modal';
import { Spinner } from './Common';
import { useToast } from './Toast';

export function SellModal({
  docId,
  item,
  mainCurrency,
  onClose,
}: {
  docId: string;
  item: Item;
  mainCurrency: string;
  onClose: () => void;
}) {
  const { toast, toastError } = useToast();
  const [draft, setDraft] = useState<ListingDraft>(() => buildTemplateDraft(item, mainCurrency));
  const [aiBusy, setAiBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const aiRanRef = useRef(false);
  const hasAiKey = Boolean(getAiKey());
  const photoCount = (item.photos ?? []).length;

  const runAi = async () => {
    if (aiBusy) return;
    setAiBusy(true);
    try {
      const aiDraft = await buildAiDraft(item, mainCurrency);
      setDraft(aiDraft);
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'AI copywriting failed');
    } finally {
      setAiBusy(false);
    }
  };

  // Draft the copy with AI once per open when a key is present; the template
  // draft stays visible (and editable) in the meantime and on failure.
  useEffect(() => {
    if (!hasAiKey || aiRanRef.current) return;
    aiRanRef.current = true;
    void runAi();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const payload = buildPayload(item, draft);

  const copy = async (text: string, what: string) => {
    if (await copyToClipboard(text)) toast(`${what} copied`);
    else toastError('Copy failed — your browser blocked clipboard access');
  };

  const downloadPhotos = async () => {
    if (photoBusy) return;
    setPhotoBusy(true);
    try {
      const saved = await downloadListingPhotos(docId, item);
      if (saved === 0) toastError('No photos are downloaded to this device yet');
      else toast(`${saved} photo${saved === 1 ? '' : 's'} saved`);
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Photo download failed');
    } finally {
      setPhotoBusy(false);
    }
  };

  return (
    <Modal title="Sell / export listing" onClose={onClose}>
      <div className="stack">
        <p className="tiny faint">
          {draft.ai
            ? 'Copy written by AI from the item fields — review before posting.'
            : hasAiKey && aiBusy
              ? 'Template draft shown; AI is writing nicer copy…'
              : 'Template draft built from the item fields.'}
        </p>

        <label className="stack tight">
          <span className="label">Title</span>
          <input
            className="input"
            aria-label="Listing title"
            value={draft.title}
            maxLength={80}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>

        <label className="stack tight">
          <span className="label">Description</span>
          <textarea
            className="input"
            aria-label="Listing description"
            rows={6}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>

        <div className="row">
          <label className="stack tight grow">
            <span className="label">Price</span>
            <input
              className="input"
              aria-label="Listing price"
              type="number"
              min={0}
              value={draft.priceAmount ?? ''}
              placeholder="No value on the item"
              onChange={(e) => {
                const n = e.target.value === '' ? null : Number(e.target.value);
                setDraft({ ...draft, priceAmount: n !== null && Number.isFinite(n) ? n : null });
              }}
            />
          </label>
          <label className="stack tight">
            <span className="label">Currency</span>
            <input
              className="input"
              aria-label="Listing currency"
              value={draft.priceCurrency}
              size={5}
              onChange={(e) => setDraft({ ...draft, priceCurrency: e.target.value.toUpperCase() })}
            />
          </label>
        </div>

        {draft.fr || draft.de ? (
          <details className="disclosure">
            <summary>Translations for Anibis ({[draft.fr && 'FR', draft.de && 'DE'].filter(Boolean).join(', ')})</summary>
            <div className="disclosure-body stack tight">
              {draft.fr ? (
                <p className="small">
                  <span className="muted">FR: </span>
                  {draft.fr}
                </p>
              ) : null}
              {draft.de ? (
                <p className="small">
                  <span className="muted">DE: </span>
                  {draft.de}
                </p>
              ) : null}
            </div>
          </details>
        ) : null}

        {hasAiKey ? (
          <button type="button" className="btn sm" disabled={aiBusy} onClick={() => void runAi()}>
            {aiBusy ? <Spinner /> : null} {aiBusy ? 'Writing copy' : 'Rewrite with AI'}
          </button>
        ) : (
          <p className="tiny faint">
            Add a Claude API key in your profile to get AI-written selling copy and FR/DE
            translations.
          </p>
        )}

        <div className="row wrap">
          <button
            type="button"
            className="btn primary"
            onClick={() => void copy(payloadJson(payload), 'Listing payload (JSON)')}
          >
            Copy for extension
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void copy(payloadText(payload), 'Listing text')}
          >
            Copy as text
          </button>
          <button
            type="button"
            className="btn"
            disabled={photoBusy || photoCount === 0}
            onClick={() => void downloadPhotos()}
          >
            {photoBusy ? <Spinner /> : null} Download photos ({photoCount})
          </button>
        </div>

        <details className="disclosure">
          <summary>Payload preview</summary>
          <div className="disclosure-body">
            <pre
              className="tiny"
              data-testid="listing-payload"
              style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text' }}
            >
              {payloadJson(payload)}
            </pre>
          </div>
        </details>

        <p className="tiny faint">
          Open the Anibis or Facebook Marketplace listing form, click the Peerventory extension,
          and it fills the form from the copied payload. Photos are attached by dragging the
          downloaded files into the form (browsers do not let extensions do that step).
        </p>
      </div>
    </Modal>
  );
}
