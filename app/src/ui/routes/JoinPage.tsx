import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { defaultRelayOrigin, rememberRelayHints, useInventories } from '../../store';
import type { UseInventoriesResult } from '../../store/contract';
import { decodeRelayHints } from '../lib/links';
import { AppHeader } from '../components/AppHeader';
import { EmptyState, LoadingPage } from '../components/Common';

/**
 * Landing route for every share link. Registers the handle locally, then
 * forwards to the token-free in-app route so the token leaves the address bar.
 */
export function JoinPage() {
  const { docId, token, key, itemId, dotIds, listId } = useParams();
  const { search } = useLocation();
  const navigate = useNavigate();
  const { joinInventory }: UseInventoriesResult = useInventories();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    if (!docId || !token) {
      setError('This link is missing an inventory or a token.');
      return;
    }
    started.current = true;

    let suffix = '';
    if (itemId) suffix = `/i/${itemId}`;
    else if (dotIds) suffix = `/l/${dotIds}`;
    else if (listId) suffix = `/sl/${listId}`;

    // Relay hints the link embedded (`?r=` inside the fragment). The wrapper
    // origin — where this page was loaded from — stays a hint too, so it is
    // stashed alongside instead of being displaced by the embedded list.
    const hinted = decodeRelayHints(new URLSearchParams(search).get('r'));
    if (hinted.length > 0) rememberRelayHints(docId, [defaultRelayOrigin(), ...hinted]);

    joinInventory(docId, token, key)
      .then(() => navigate(`/inv/${docId}${suffix}`, { replace: true }))
      .catch((err: unknown) => {
        setError(
          err instanceof Error
            ? err.message
            : 'The link could not be opened. It may have been revoked.',
        );
      });
  }, [docId, token, key, itemId, dotIds, listId, joinInventory, navigate]);

  if (error) {
    return (
      <>
        <AppHeader title="Cannot open link" back="/" />
        <main className="page narrow">
          <EmptyState
            title="This share link did not open"
            body={error}
            action={
              <button type="button" className="btn primary" onClick={() => navigate('/')}>
                Go to inventories
              </button>
            }
          />
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader title="Opening share link" />
      <main className="page narrow">
        <LoadingPage label="Joining inventory" />
      </main>
    </>
  );
}
