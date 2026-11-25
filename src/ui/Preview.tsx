import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ChevronLeft, ChevronRight, FileQuestion, Maximize, Minus, Plus, X } from 'lucide-react';
import type { FileEntry } from '../../shared/protocol';
import { previewType } from '../lib/files';
import { fallbackLimit, readLimited } from '../lib/io';
import { openMedia } from '../lib/media-stream';
import { errorText, type T } from '../lib/i18n';
import type { Transfers } from '../lib/transfers';
import { Empty, Spinner } from './common';

const PdfPreview = lazy(() => import('./PdfPreview'));

export default function Preview({ file, items, transfers, close, open, download, t, signal }: {
  file: FileEntry; items: FileEntry[]; transfers: Transfers; close: () => void; open: (file: FileEntry) => void;
  download: (file: FileEntry) => void; t: T; signal: AbortSignal;
}) {
  const [content, setContent] = useState<{ id: string; data: string }>();
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const dialog = useRef<HTMLDialogElement>(null);
  const kind = previewType(file);
  const streaming = file.size > fallbackLimit && !!kind && /^(audio|video)\//.test(kind) && !!navigator.serviceWorker?.controller;
  const supported = kind && (streaming || file.size <= (kind === 'text/plain' ? 2 * 1024 * 1024 : fallbackLimit));
  const index = items.findIndex(e => e.id === file.id);
  const navigate = (offset: number) => {
    const entry = items[index + offset];
    if (entry) { setZoom(1); open(entry); }
  };
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  useEffect(() => {
    if (!kind || !supported) return;
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, signal]);
    let url: string | undefined;
    let closeStream: (() => void) | undefined;
    void (async () => {
      try {
        setError('');
        if (streaming) {
          const media = await openMedia(kind, file.size, (start, end, rangeSignal) => transfers.range(file, start, end, rangeSignal), combined);
          if (combined.aborted) { media.close(); return; }
          closeStream = media.close;
          setContent({ id: file.id, data: media.url });
          return;
        }
        const blob = await readLimited(transfers.stream(file, undefined, combined), fallbackLimit, kind);
        const data = kind === 'text/plain' ? await blob.text() : URL.createObjectURL(blob);
        if (kind !== 'text/plain') url = data;
        if (combined.aborted) { if (url) URL.revokeObjectURL(url); return; }
        setContent({ id: file.id, data });
      } catch (e) { if (!combined.aborted) setError(errorText(e, t)); }
    })();
    return () => { controller.abort(); closeStream?.(); if (url) URL.revokeObjectURL(url); };
  }, [file, transfers, supported, streaming, kind, signal, t]);
  const view = content?.id === file.id ? content.data : undefined;
  const fullscreen = () => {
    const action = document.fullscreenElement ? document.exitFullscreen?.() : dialog.current?.requestFullscreen?.();
    void action?.catch(() => setError(t('A tela cheia está indisponível.', 'Full screen is unavailable.')));
  };
  return <dialog className="preview" ref={dialog} aria-label={file.name} onCancel={e => { e.preventDefault(); close(); }} onKeyDown={e => { if (e.key === 'ArrowLeft') navigate(-1); if (e.key === 'ArrowRight') navigate(1); }}>
    <header className="preview-bar">
      <button className="icon-button" title={t('Fechar', 'Close')} onClick={close}><X size={22} /></button><strong title={file.name}>{file.name}</strong>
      <div className="inline-actions">
        {view !== undefined && (kind?.startsWith('image/') || kind === 'text/plain' || kind === 'application/pdf') && <>
          <button className="icon-button" title={t('Reduzir zoom', 'Zoom out')} onClick={() => setZoom(n => Math.max(0.25, n - .25))}><Minus size={18} /></button>
          <small>{Math.round(zoom * 100)}%</small><button className="icon-button" title={t('Aumentar zoom', 'Zoom in')} onClick={() => setZoom(n => Math.min(3, n + .25))}><Plus size={18} /></button>
        </>}
        <button className="icon-button" title={t('Tela cheia', 'Full screen')} onClick={fullscreen}><Maximize size={18} /></button>
        <button className="icon-button" title={t('Baixar', 'Download')} onClick={() => download(file)}><ArrowDownToLine size={19} /></button>
      </div>
    </header>
    <div className="preview-view">
      {error ? <Empty icon={<FileQuestion size={30} />} title={t('Visualização indisponível', 'Preview unavailable')} detail={error} /> :
        !supported ? <Empty icon={<FileQuestion size={30} />} title={t('Visualização indisponível', 'Preview unavailable')} detail={kind ? t('Este arquivo excede o limite de visualização. Baixe para abrir em outro aplicativo.', 'This file exceeds the preview limit. Download it to open in another app.') : t('Baixe o arquivo para abrir em um aplicativo compatível.', 'Download this file to open it in a compatible app.')} /> :
        view === undefined ? <div className="preview-loading"><Spinner />{t('Descriptografando no dispositivo…', 'Decrypting on this device…')}</div> :
        kind?.startsWith('image/') ? <img alt={file.name} src={view} style={{ scale: zoom }} onError={() => setError(t('Formato de imagem incompatível.', 'Unsupported image format.'))} /> :
        kind?.startsWith('video/') ? <video src={view} controls playsInline onError={() => setError(t('Formato de vídeo incompatível neste navegador.', 'Video format unsupported in this browser.'))} /> :
        kind?.startsWith('audio/') ? <audio src={view} controls onError={() => setError(t('Formato de áudio incompatível neste navegador.', 'Audio format unsupported in this browser.'))} /> :
        kind === 'text/plain' ? <pre style={{ fontSize: `${zoom}rem` }}>{view}</pre> :
          <Suspense fallback={<Spinner />}><PdfPreview url={view} zoom={zoom} t={t} /></Suspense>}
    </div>
    <footer><button className="secondary" disabled={index <= 0} onClick={() => navigate(-1)}><ChevronLeft size={18} />{t('Anterior', 'Previous')}</button><span>{index >= 0 ? `${index + 1} / ${items.length}` : ''}</span><button className="secondary" disabled={index < 0 || index >= items.length - 1} onClick={() => navigate(1)}>{t('Próximo', 'Next')}<ChevronRight size={18} /></button></footer>
  </dialog>;
}
