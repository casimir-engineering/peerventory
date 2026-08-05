/**
 * Profile-level modals shared between the home screen (first-run welcome)
 * and the Account & sync page (edit name, manage the AI key).
 */

import { useState } from 'react';

import { Field } from './Fields';
import { Modal } from './Modal';

export function NameModal({
  welcome,
  initialValue,
  onClose,
  onSave,
}: {
  welcome: boolean;
  initialValue: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(initialValue);
  const submit = () => {
    const value = name.trim();
    if (value) onSave(value);
  };

  return (
    <Modal
      title={welcome ? 'Welcome' : 'Your name'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn grow" onClick={onClose}>
            {welcome ? 'Skip for now' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn primary grow"
            disabled={!name.trim()}
            onClick={submit}
          >
            Save
          </button>
        </>
      }
    >
      <p className="small muted">Your name is used as the default owner of items you add.</p>
      <Field label="Name">
        <input
          className="input lg"
          autoFocus
          autoComplete="name"
          value={name}
          placeholder="Your name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
      </Field>
    </Modal>
  );
}

export function AiKeyModal({
  hasKey,
  onClose,
  onSave,
}: {
  hasKey: boolean;
  onClose: () => void;
  /** Empty string removes the stored key. */
  onSave: (key: string) => void;
}) {
  const [key, setKey] = useState('');

  return (
    <Modal
      title="Claude API key"
      onClose={onClose}
      footer={
        <>
          {hasKey ? (
            <button type="button" className="btn danger grow" onClick={() => onSave('')}>
              Remove key
            </button>
          ) : (
            <button type="button" className="btn grow" onClick={onClose}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="btn primary grow"
            disabled={!key.trim()}
            onClick={() => onSave(key.trim())}
          >
            Save
          </button>
        </>
      }
    >
      <p className="small muted">
        Used for AI photo autofill and AI-written selling copy. Calls go straight from this device
        to Anthropic; the key is stored only here and never shared or synced.
      </p>
      <Field label="API key">
        <input
          className="input"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={key}
          placeholder="sk-ant-..."
          onChange={(event) => setKey(event.target.value)}
        />
      </Field>
    </Modal>
  );
}
