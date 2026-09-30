import { useEffect, useRef, useState } from 'react';
import { Modal } from './ui';
import { tr } from '../lib/i18n';

/**
 * Camera QR scanner. Uses the built-in BarcodeDetector where available (Chrome/Android), otherwise jsQR
 * (loaded on demand). Everything happens locally — frames never leave the device.
 */
export function QrScanner({ title, hint, onResult, onClose }: { title: string; hint?: string; onResult: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    let raf = 0;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch {
        setErr(tr('无法打开摄像头（请检查浏览器权限）'));
        return;
      }
      if (stop) return stream.getTracks().forEach((t) => t.stop());
      const v = video.current!;
      v.srcObject = stream;
      await v.play().catch(() => undefined);
      type BD = { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> };
      const Native = (window as unknown as { BarcodeDetector?: new (o: unknown) => BD }).BarcodeDetector;
      const native = Native ? new Native({ formats: ['qr_code'] }) : null;
      const jsQR = native ? null : (await import('jsqr')).default;
      const canvas = document.createElement('canvas');
      const g = canvas.getContext('2d', { willReadFrequently: true })!;
      const tick = async () => {
        if (stop) return;
        if (v.readyState >= 2 && v.videoWidth) {
          try {
            if (native) {
              const r = await native.detect(v);
              if (r[0]?.rawValue) return onResult(r[0].rawValue);
            } else if (jsQR) {
              const w = Math.min(640, v.videoWidth);
              const h = Math.round((v.videoHeight / v.videoWidth) * w);
              canvas.width = w;
              canvas.height = h;
              g.drawImage(v, 0, 0, w, h);
              const r = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
              if (r?.data) return onResult(r.data);
            }
          } catch {
            /* keep trying */
          }
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    })();
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title={title} onClose={onClose}>
      {hint && <p className="muted small">{hint}</p>}
      {err ? <p className="error">{err}</p> : <video ref={video} className="qr-video" playsInline muted />}
    </Modal>
  );
}
