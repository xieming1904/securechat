/** Blur everything while the app is in the background (optional, on by default). */
import { prefs } from './prefs';

function update() {
  const hidden = document.visibilityState === 'hidden';
  document.documentElement.classList.toggle('privacy-blur', prefs().privacyScreen && (hidden || (blurOnFocusLoss && !document.hasFocus())));
}
let blurOnFocusLoss = false;
/** Also blur when the window merely loses focus (desktop), not only when it is hidden. */
export function setBlurOnFocusLoss(v: boolean) {
  blurOnFocusLoss = v;
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', update);
  window.addEventListener('blur', update);
  window.addEventListener('focus', update);
  window.addEventListener('pagehide', () => prefs().privacyScreen && document.documentElement.classList.add('privacy-blur'));
  window.addEventListener('pageshow', update);
}
