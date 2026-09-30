import type { LinkPreview } from '../crypto/core';
import { safeThumb } from '../lib/linkpreview';

export function LinkCard({ p, compact }: { p: LinkPreview; compact?: boolean }) {
  let href = '';
  try {
    const u = new URL(p.url);
    if (u.protocol === 'http:' || u.protocol === 'https:') href = u.toString();
  } catch {
    /* not a link */
  }
  const img = safeThumb(p.img);
  const body = (
    <>
      {img && <img src={img} alt="" />}
      <div className="lp-body">
        {p.site && <div className="lp-site">{p.site}</div>}
        <div className="lp-title">{p.title}</div>
        {p.desc && !compact && <div className="lp-desc">{p.desc}</div>}
      </div>
    </>
  );
  if (compact || !href) return <div className={`link-card ${compact ? 'compact' : ''}`}>{body}</div>;
  return (
    <a className="link-card" href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" onClick={(e) => e.stopPropagation()}>
      {body}
    </a>
  );
}
