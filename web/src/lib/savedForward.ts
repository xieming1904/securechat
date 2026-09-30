import type { SavedItem } from './social';
import { forwardPayload } from './store';

/** Forward a saved item into a chat (attachments are re-uploaded into that chat, still encrypted). */
export function forwardSaved(it: SavedItem, chatId: string) {
  return forwardPayload(it.p, chatId, it.from);
}
