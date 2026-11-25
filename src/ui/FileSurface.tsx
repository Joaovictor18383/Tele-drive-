import { useCallback, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { AppWindow, Archive, AudioLines, CircleCheck, File, FileImage, FileText, Film, FolderClosed, MoreHorizontal, Star } from 'lucide-react';
import { Virtuoso, VirtuosoGrid } from 'react-virtuoso';
import type { Entry } from '../../shared/protocol';
import { mediaKind } from '../lib/files';
import { dateText, sizeText, type Language, type T } from '../lib/i18n';

const icons = { image: FileImage, video: Film, audio: AudioLines, pdf: FileText, text: FileText, document: FileText, archive: Archive, executable: AppWindow, file: File };
export function EntryIcon({ item, large }: { item: Entry; large?: boolean }) {
  const kind = item.kind === 'folder' ? 'folder' : mediaKind(item);
  const Icon = kind === 'folder' ? FolderClosed : icons[kind];
  return <span className={`entry-icon kind-${kind} ${item.kind === 'folder' ? 'folder-' + item.color : ''} ${large ? 'entry-large' : ''}`}><Icon size={large ? 29 : 18} strokeWidth={large ? 1.65 : 1.8} /></span>;
}

export function kindLabel(item: Entry, t: T) {
  if (item.kind === 'folder') return t('Pasta', 'Folder');
  const pair: Record<keyof typeof icons, [string, string]> = {
    image: ['Imagem', 'Image'], video: ['Vídeo', 'Video'], audio: ['Áudio', 'Audio'], pdf: ['PDF', 'PDF'],
    text: ['Texto', 'Text'], document: ['Documento', 'Document'], archive: ['Arquivo compactado', 'Archive'],
    executable: ['Executável', 'Executable'], file: ['Arquivo', 'File']
  };
  return t(...pair[mediaKind(item)]);
}

type Props = {
  items: Entry[]; view: 'list' | 'grid'; selection: Set<string>; t: T; lang: Language; scroll: HTMLElement | null;
  select: (item: Entry, event: React.MouseEvent) => void; toggle: (item: Entry) => void; all: () => void;
  open: (item: Entry) => void; menu: (items: Entry[], x: number, y: number) => void;
  moveDrop: (ids: string[], folder: string) => void;
};

export function FileSurface({ items, view, selection, t, lang, scroll, select, toggle, all, open, menu, moveDrop }: Props) {
  const gesture = useRef<{ id: string; x: number; y: number } | null>(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPress = useRef(false);
  const [hoverFolder, setHoverFolder] = useState('');
  const stop = () => { if (press.current) clearTimeout(press.current); gesture.current = null; };
  const menuFor = (item: Entry, x: number, y: number) => menu(selection.has(item.id) ? items.filter(e => selection.has(e.id)) : [item], x, y);
  const surface = (item: Entry, grid: boolean) => {
    const selected = selection.has(item.id);
    const onMenu = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); menuFor(item, e.clientX, e.clientY); };
    return <div className={`${grid ? 'file-card' : 'file-row'} ${selected ? 'selected' : ''} ${hoverFolder === item.id ? 'drop-target' : ''}`}
      draggable={!item.trash} tabIndex={0} role="group" aria-label={item.name}
      onClick={e => {
        if (longPress.current) { longPress.current = false; return; }
        if (matchMedia('(pointer: coarse)').matches && !selection.size && !e.shiftKey) open(item);
        else select(item, e);
      }}
      onDoubleClick={() => open(item)} onContextMenu={onMenu}
      onPointerDown={e => {
        longPress.current = false;
        if (e.pointerType !== 'touch') return;
        stop();
        gesture.current = { id: item.id, x: e.clientX, y: e.clientY };
        press.current = setTimeout(() => {
          if (!gesture.current) return;
          longPress.current = true;
          menuFor(item, gesture.current.x, gesture.current.y);
        }, 550);
      }}
      onPointerMove={e => { if (gesture.current && (Math.abs(e.clientX - gesture.current.x) > 10 || Math.abs(e.clientY - gesture.current.y) > 10)) stop(); }}
      onPointerUp={stop} onPointerCancel={stop}
      onKeyDown={e => {
        if (e.key === 'Enter' && e.target === e.currentTarget) open(item);
        if (e.key === ' ' && e.target === e.currentTarget) { e.preventDefault(); toggle(item); }
        if (e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10') { const r = e.currentTarget.getBoundingClientRect(); menuFor(item, r.left + 35, r.top + 35); }
      }}
      onDragStart={e => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-cloudvault-items', JSON.stringify(selected ? [...selection] : [item.id]));
      }}
      onDragOver={e => { if (item.kind === 'folder' && !item.trash && e.dataTransfer.types.includes('application/x-cloudvault-items')) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setHoverFolder(item.id); } }}
      onDragLeave={() => setHoverFolder(old => old === item.id ? '' : old)}
      onDrop={e => {
        if (item.kind !== 'folder' || item.trash || !e.dataTransfer.types.includes('application/x-cloudvault-items')) return;
        e.preventDefault(); e.stopPropagation(); setHoverFolder('');
        try { moveDrop(JSON.parse(e.dataTransfer.getData('application/x-cloudvault-items')), item.id); } catch { /* Invalid native drag. */ }
      }}>
      {grid ? <><div className="file-card-top">
        <button className="select-item" aria-label={selected ? t('Desmarcar', 'Deselect') : t('Selecionar', 'Select')} aria-pressed={selected} onClick={e => { e.stopPropagation(); toggle(item); }}>{selected ? <CircleCheck size={20} /> : <span />}</button>
        <button className="icon-button file-more" aria-label={t('Mais ações', 'More actions')} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); e.stopPropagation(); menuFor(item, r.right, r.bottom); }}><MoreHorizontal size={20} /></button>
      </div><div className="file-card-art"><EntryIcon item={item} large /></div>
      <div className="file-card-info"><strong title={item.name}>{item.name}</strong><small>{item.kind === 'folder' ? kindLabel(item, t) : sizeText(item.size, lang)}</small></div></> :
        <><div className="file-row-name">
          <button className="select-item" aria-label={selected ? t('Desmarcar', 'Deselect') : t('Selecionar', 'Select')} aria-pressed={selected} onClick={e => { e.stopPropagation(); toggle(item); }}>{selected ? <CircleCheck size={20} /> : <span />}</button>
          <EntryIcon item={item} /><strong title={item.name}>{item.name}</strong>{item.favorite && <Star size={14} className="file-star" />}
        </div><small className="file-date">{dateText(item.updated, lang)}</small><small className="file-size">{item.kind === 'folder' ? '—' : sizeText(item.size, lang)}</small>
        <button className="icon-button file-more" aria-label={t('Mais ações', 'More actions')} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); e.stopPropagation(); menuFor(item, r.right, r.bottom); }}><MoreHorizontal size={20} /></button></>}
    </div>;
  };
  const content = useCallback((_: number, item: Entry) => surface(item, view === 'grid'), [items, view, selection, hoverFolder, t, lang, select, toggle, open, menu, moveDrop]);
  const countAll = items.length > 0 && items.every(item => selection.has(item.id));
  const shell = useMemo(() => ({ overscan: 170, customScrollParent: scroll ?? undefined, computeItemKey: (_: number, e: Entry) => e.id }), [scroll]);
  return <>
    {view === 'list' && <div className="file-columns">
      <div><input type="checkbox" checked={countAll} onChange={all} aria-label={t('Selecionar todos', 'Select all')} /><span>{t('Nome', 'Name')}</span></div><span className="file-date">{t('Modificado em', 'Modified')}</span><span className="file-size">{t('Tamanho', 'Size')}</span><span />
    </div>}
    {items.length < 100 || !scroll ? <div className={view === 'grid' ? 'file-grid' : 'file-list'}>{items.map(item => <div className="file-item" key={item.id}>{surface(item, view === 'grid')}</div>)}</div> :
      view === 'grid' ? <VirtuosoGrid {...shell} data={items} listClassName="file-grid" itemClassName="file-item" itemContent={content} /> :
        <Virtuoso {...shell} data={items} itemContent={content} />}
  </>;
}

export function Meter({ title, amount, label, color }: { title: string; amount: number; label: ReactNode; color: string }) {
  return <div className="meter-row"><strong>{title}</strong><span className="meter" style={{ '--meter': `${amount}%`, '--meter-color': color } as CSSProperties}><span /></span><small>{label}</small></div>;
}
