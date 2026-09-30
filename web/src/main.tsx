import '@fontsource-variable/inter';
import './styles.css';
import { applyPrefs } from './lib/prefs';
import { loadLanguage } from './lib/i18n';
import { installErrorReporting } from './lib/errorreport';

applyPrefs();
installErrorReporting();

// The English table must be in place before any module computes its (translated) constants,
// so the rest of the app is imported only after it has loaded.
loadLanguage()
  .catch(() => undefined)
  .then(async () => {
    const [{ createRoot }, { default: App }, { registerServiceWorker }] = await Promise.all([
      import('react-dom/client'),
      import('./App'),
      import('./lib/notify'),
    ]);
    registerServiceWorker();
    createRoot(document.getElementById('root')!).render(<App />);
  });
