/**
 * Decrypted avatar pictures, as a tiny store with no dependencies — so the shared <Avatar> component can read it
 * without importing the app store (which would create an import cycle). Filled by lib/avatars.ts.
 */
import { create } from 'zustand';
import type { AvatarRef } from '../crypto/core';

export interface AvatarState {
  /** userId → picture */
  users: Record<string, { v: number; url: string }>;
  /** chatId → group picture */
  groups: Record<string, { blobId: string; url: string }>;
  mine: (AvatarRef & { v: number }) | null;
  /** my user id (to pick the peer of a direct chat) */
  meId: string | null;
}
export const useAvatars = create<AvatarState>(() => ({ users: {}, groups: {}, mine: null, meId: null }));
