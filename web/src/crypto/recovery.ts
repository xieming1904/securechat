/** 24-word recovery phrase (BIP-39 English wordlist, 256-bit entropy with checksum). */
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export function newRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 256);
}

/** Normalise user input: lower-case, single spaces. Returns null if the checksum fails. */
export function normalizeRecoveryPhrase(input: string): string | null {
  const p = input.trim().toLowerCase().split(/[\s,，、]+/).filter(Boolean).join(' ');
  return p.split(' ').length === 24 && validateMnemonic(p, wordlist) ? p : null;
}
