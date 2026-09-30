import { Component, type ReactNode } from 'react';
import { tr } from '../lib/i18n';
import { reportError } from '../lib/errorreport';

/** Contain rendering errors (e.g. from a malformed message) so one bad item can't take down the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    console.warn('render error contained', e);
    reportError(e, 'render');
  }
  render() {
    if (this.state.failed) return this.props.fallback ?? <div className="muted small">{tr('[无法显示的内容]')}</div>;
    return this.props.children;
  }
}
