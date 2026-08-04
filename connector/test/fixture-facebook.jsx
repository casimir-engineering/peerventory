/**
 * Local stand-in for the Facebook Marketplace "Create listing" form, built
 * with the same React (19) the app uses, as a genuinely CONTROLLED form: if
 * the extension wrote to .value directly without the native-setter +
 * dispatchEvent trick, React state would keep the old value and the
 * <pre id="state"> dump (what the test asserts on) would stay empty.
 *
 * Mirrors typical structure (aria-labels, label-wrapped inputs, a
 * role=combobox for category), NOT the live page — a logged-in manual test
 * against the real form is still required.
 *
 * Built by test/run-tests.mjs with the app's esbuild into dist/fixture-facebook.js.
 */

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

function CreateListing() {
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState(0);
  // Live 2026-08: the Description textarea only MOUNTS after the collapsed
  // "More details" disclosure is expanded; the fixture mirrors that so the
  // e2e covers the expand-then-fill path in content/facebook.js prepare().
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <div style={{ maxWidth: 560, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>Item for sale</h1>
      <label style={{ display: 'block', margin: '14px 0' }}>
        <span>Title</span>
        <input
          aria-label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{ width: '100%' }}
        />
      </label>
      <label style={{ display: 'block', margin: '14px 0' }}>
        <span>Price</span>
        <input
          aria-label="Price"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          style={{ width: '100%' }}
        />
      </label>
      <div role="combobox" aria-label="Category" tabIndex={0} style={{ margin: '14px 0' }}>
        Category ▾
      </div>
      <div role="combobox" aria-label="Condition" tabIndex={0} style={{ margin: '14px 0' }}>
        Condition ▾
      </div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setMoreOpen(true)}
        style={{ margin: '14px 0', cursor: 'pointer' }}
      >
        More details
        <div style={{ fontSize: 12, color: '#888' }}>Attract more interest by adding details.</div>
      </div>
      {moreOpen && (
        <label style={{ display: 'block', margin: '14px 0' }}>
          <span>Description</span>
          <textarea
            aria-label="Description"
            rows={6}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={{ width: '100%' }}
          />
        </label>
      )}
      <p>
        Photos: <em>drag photos here</em>
      </p>
      {/* Hidden file input like the live "Add photos" tile; the staged-photo
          attach must reach React through a bubbling change event. */}
      <input
        type="file"
        aria-label="Add photos"
        accept="image/*,video/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => setPhotos(e.target.files.length)}
      />
      {/* React-side view of the state, asserted by the automated test. */}
      <pre id="state">{JSON.stringify({ title, price, description, photos })}</pre>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<CreateListing />);
