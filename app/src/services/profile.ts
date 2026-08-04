/**
 * Local user profile + generic recent-input history. Plain localStorage JSON,
 * versioned keys; every read tolerates missing/corrupt data.
 */

import type { Id } from '../types';

const PROFILE_KEY = 'profile:v1';
const INPUTS_KEY = 'inputs:v1';
const INPUTS_CAP = 20;

interface Profile {
  userName?: string;
  ownerAliases?: Record<string, string>;
  lastCurrency?: string;
}

function readProfile(): Profile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Profile;
  } catch {
    // corrupt -> start fresh
  }
  return {};
}

function writeProfile(patch: Partial<Profile>): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...readProfile(), ...patch }));
  } catch {
    // storage unavailable: profile is best-effort
  }
}

export function getUserName(): string | null {
  const name = readProfile().userName;
  return typeof name === 'string' && name.trim() ? name : null;
}

export function setUserName(name: string): void {
  writeProfile({ userName: name.trim() });
}

export function getOwnerAliases(): Record<string, string> {
  const aliases = readProfile().ownerAliases;
  return aliases && typeof aliases === 'object' ? { ...aliases } : {};
}

export function ownerAliasFor(docId: Id): string | null {
  const aliases = readProfile().ownerAliases;
  const alias = aliases && typeof aliases === 'object' ? aliases[docId] : undefined;
  return typeof alias === 'string' && alias.trim() ? alias : null;
}

export function setOwnerAlias(docId: Id, name: string): void {
  const aliases = { ...(readProfile().ownerAliases ?? {}) };
  const trimmed = name.trim();
  if (trimmed) aliases[docId] = trimmed;
  else delete aliases[docId];
  writeProfile({ ownerAliases: aliases });
}

/** Per-doc alias if set, else the global user name. */
export function effectiveOwnerName(docId: Id): string | null {
  return ownerAliasFor(docId) ?? getUserName();
}

function readInputs(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(INPUTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const out: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) out[k] = v.filter((s): s is string => typeof s === 'string');
      }
      return out;
    }
  } catch {
    // corrupt -> start fresh
  }
  return {};
}

/** Push a value to a key's history (most recent first, deduped, cap 20). */
export function rememberInput(key: string, value: string): void {
  const v = value.trim();
  if (!v) return;
  const inputs = readInputs();
  inputs[key] = [v, ...(inputs[key] ?? []).filter((s) => s !== v)].slice(0, INPUTS_CAP);
  try {
    localStorage.setItem(INPUTS_KEY, JSON.stringify(inputs));
  } catch {
    // best-effort
  }
}

export function suggestInputs(key: string): string[] {
  return readInputs()[key] ?? [];
}

export function getLastCurrency(): string | null {
  const code = readProfile().lastCurrency;
  return typeof code === 'string' && code ? code : null;
}

export function setLastCurrency(code: string): void {
  writeProfile({ lastCurrency: code.toUpperCase() });
}
