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
      <p>
        Photos: <em>drag photos here</em>
      </p>
      {/* React-side view of the state, asserted by the automated test. */}
      <pre id="state">{JSON.stringify({ title, price, description })}</pre>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<CreateListing />);
