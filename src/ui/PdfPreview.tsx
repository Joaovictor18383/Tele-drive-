import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { AnnotationMode, GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { T } from '../lib/i18n';
import { Spinner } from './common';

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfPreview({ url, zoom, t }: { url: string; zoom: number; t: T }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [error, setError] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    setPdf(undefined); setPage(1); setError(false);
    const task = getDocument({ url, enableXfa: false, useWasm: false, disableFontFace: true });
    void task.promise.then(value => { if (mounted) setPdf(value); }).catch(() => { if (mounted) setError(true); });
    return () => { mounted = false; void task.destroy().catch(() => undefined); };
  }, [url]);
  useEffect(() => {
    if (!pdf) return;
    let mounted = true;
    let task: RenderTask | undefined;
    void (async () => {
      try {
        const current = await pdf.getPage(page);
        if (!mounted || !canvas.current) return;
        const base = current.getViewport({ scale: 1 });
        const width = Math.max(220, Math.min(950, (container.current?.clientWidth ?? 800) - 24));
        const cssScale = width / base.width * zoom;
        const deviceScale = Math.min(devicePixelRatio || 1, 1.5, 3200 / (Math.max(base.width, base.height) * cssScale));
        const viewport = current.getViewport({ scale: cssScale * deviceScale });
        const target = canvas.current;
        target.width = Math.max(1, Math.floor(viewport.width));
        target.height = Math.max(1, Math.floor(viewport.height));
        target.style.width = Math.round(base.width * cssScale) + 'px';
        task = current.render({ canvas: target, viewport, annotationMode: AnnotationMode.DISABLE });
        await task.promise;
      } catch { if (mounted) setError(true); }
    })();
    return () => { mounted = false; task?.cancel(); };
  }, [pdf, page, zoom]);

  if (error) return <div className="callout error" role="alert">{t('Não foi possível renderizar este PDF.', 'This PDF could not be rendered.')}</div>;
  return <div className="pdf-display" ref={container}>
    {pdf ? <div className="pdf-nav"><button className="icon-button" disabled={page <= 1} aria-label={t('Página anterior', 'Previous page')} onClick={() => setPage(page - 1)}><ChevronLeft size={18} /></button>
      <span>{t('Página', 'Page')} {page} / {pdf.numPages}</span>
      <button className="icon-button" disabled={page >= pdf.numPages} aria-label={t('Próxima página', 'Next page')} onClick={() => setPage(page + 1)}><ChevronRight size={18} /></button></div> : <Spinner />}
    <canvas hidden={!pdf} ref={canvas} />
  </div>;
}
