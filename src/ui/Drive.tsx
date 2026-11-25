import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type FormEvent, type MouseEvent } from 'react';
import {
  Activity, ArrowDownToLine, ArrowDownWideNarrow, ArrowUp, ArrowUpFromLine, Check, ChevronDown, ChevronRight, Clock3, Cloud,
  CloudUpload, Copy, Eye, FileText, Film, FolderClosed, FolderInput, FolderPlus, Globe2, Grid2X2, HardDrive, Home, Image,
  Info, LayoutList, LockKeyhole, Menu, Pencil, Plus, RefreshCw, Search, Settings2, ShieldCheck, Star, Trash2, X
} from 'lucide-react';
import { AnimatePresence, m } from 'motion/react';
import { folderColors, wireBlock, plainBlock, cipherSize, type Change, type Color, type Entry, type FileEntry, type Profile } from '../../shared/protocol';
import { ancestry, effectiveParent, isDescendant, isTrashed, subtree } from '../../shared/tree';
import { api, RequestError } from '../lib/api';
import { checked, directoryPicker, mediaKind, newFolder, normal, readDirectory, readDrop, selectedRoots, uniqueName, type Dropped } from '../lib/files';
import { dateText, errorText, locale, sizeText, type T } from '../lib/i18n';
import { destination } from '../lib/io';
import type { Preferences } from '../lib/preferences';
import { Transfers } from '../lib/transfers';
import type { Vault } from '../lib/vault';
import { Avatar, Brand, Dialog, Empty, Spinner } from './common';
import { EntryIcon, FileSurface, kindLabel, Meter } from './FileSurface';
import { TransferPanel } from './TransferPanel';

const Settings = lazy(() => import('./Settings'));
const Preview = lazy(() => import('./Preview'));
const pages = [
  ['home', Home, 'Início', 'Home'], ['drive', HardDrive, 'Meu Drive', 'My Drive'],
  ['photos', Image, 'Fotos', 'Photos'], ['videos', Film, 'Vídeos', 'Videos'], ['documents', FileText, 'Documentos', 'Documents'],
  ['recent', Clock3, 'Recentes', 'Recent'], ['favorites', Star, 'Favoritos', 'Starred'], ['trash', Trash2, 'Lixeira', 'Trash'],
  ['transfers', Activity, 'Transferências', 'Transfers'], ['storage', Cloud, 'Armazenamento', 'Storage'],
  ['settings', Settings2, 'Configurações', 'Settings']
] as const;
type Page = typeof pages[number][0];
type Sort = 'name' | 'size' | 'updated';
type Modal = { kind: 'new' } | { kind: 'rename' | 'color' | 'details'; entry: Entry } |
  { kind: 'move' | 'copy' | 'purge'; items: Entry[] };
type Context = { items: Entry[]; x: number; y: number };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const placement = () => {
  const [page, folder] = location.hash.slice(1).split('/');
  return { page: (pages.some(row => row[0] === page) ? page : 'home') as Page, folder: page === 'drive' && uuidPattern.test(folder ?? '') ? folder : null };
};
const guides: Record<Page, [string, string]> = {
  home: ['Seus arquivos, em um só lugar.', 'All your files in one place.'],
  drive: ['Navegue e organize seus arquivos e pastas.', 'Browse and organize your files and folders.'],
  photos: ['Imagens protegidas pelo seu cofre.', 'Images protected by your vault.'],
  videos: ['Vídeos armazenados no seu cofre.', 'Videos stored in your vault.'],
  documents: ['PDFs, textos e outros documentos.', 'PDFs, text and other documents.'],
  recent: ['Arquivos ordenados pelas alterações mais recentes.', 'Files ordered by the latest changes.'],
  favorites: ['Acesso rápido aos itens marcados com estrela.', 'Quick access to starred items.'],
  trash: ['Restaure itens ou exclua-os permanentemente.', 'Restore items or permanently delete them.'],
  transfers: ['Acompanhe envios e downloads neste dispositivo.', 'Track uploads and downloads on this device.'],
  storage: ['Acompanhe o espaço usado pelo CloudVault nas Mensagens Salvas.', 'Track CloudVault usage in Saved Messages.'],
  settings: ['Gerencie sua conta e as preferências deste dispositivo.', 'Manage your account and device preferences.']
};
const colorLabels: Record<Color, [string, string]> = { slate: ['Cinza', 'Gray'], blue: ['Azul', 'Blue'], violet: ['Violeta', 'Violet'], amber: ['Âmbar', 'Amber'], green: ['Verde', 'Green'], rose: ['Rosa', 'Pink'] };

function Skeleton() {
  return <div className="skeleton-list" aria-busy="true">{Array.from({ length: 5 }, (_, i) => <div key={i}><i /><i /><i /></div>)}</div>;
}

export default function Drive({ vault, profile, prefs, setPrefs, t, reduced, logout, lock, onRecovery, install, reopenRecovery, onExpired }: {
  vault: Vault; profile: Profile; prefs: Preferences; setPrefs: (prefs: Preferences) => void; t: T; reduced: boolean;
  logout: (revoke: boolean) => Promise<void>; lock: () => void; onRecovery: (code: string) => void; install?: () => void;
  reopenRecovery?: () => void;
  onExpired: () => void;
}) {
  const { entries, offline, recoveryRequired, journalBytes } = useSyncExternalStore(vault.subscribe, vault.getSnapshot);
  const [route, setRoute] = useState(placement);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState('');
  const [scroll, setScroll] = useState<HTMLElement | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [compact, setCompact] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  const [asc, setAsc] = useState(true);
  const [menu, setMenu] = useState<'new' | 'profile' | 'sort'>();
  const [context, setContext] = useState<Context>();
  const [modal, setModal] = useState<Modal>();
  const [modalError, setModalError] = useState('');
  const [modalBusy, setModalBusy] = useState(false);
  const [color, setColor] = useState<Color>('blue');
  const [targetFolder, setTargetFolder] = useState<string | null>(null);
  const [searchFolder, setSearchFolder] = useState('');
  const [previewId, setPreviewId] = useState('');
  const [toast, setToast] = useState<{ value: string; error: boolean; id: number }>();
  const [float, setFloat] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [drag, setDrag] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [limit, setLimit] = useState<number>();
  const [transfers] = useState(() => new Transfers(vault));
  const dragCount = useRef(0);
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedItems = [...selection].map(key => entries.get(key)).filter((e): e is Entry => !!e);
  const actualPage = recoveryRequired ? 'settings' : route.page;
  const folder = route.folder && entries.get(route.folder);
  const parent = actualPage === 'drive' && folder && folder.kind === 'folder' && !isTrashed(entries, folder) ? folder.id : null;
  const path = ancestry(entries, parent);
  const hasQuery = !!query.trim();
  const canEdit = actualPage === 'home' || actualPage === 'drive';
  const activeFolder = actualPage === 'drive' ? parent : null;
  const preview = entries.get(previewId);
  const max = limit ?? 4000 * wireBlock;

  const notify = (value: string, error = false) => setToast({ value, error, id: Date.now() });
  const failure = (e: unknown) => {
    if (e instanceof RequestError && e.status === 401) { void onExpired(); return; }
    notify(errorText(e, t), true);
  };
  const navigate = (page: Page, folderId: string | null = null) => {
    setDrawer(false); setMenu(undefined);
    if (recoveryRequired && page !== 'settings') { notify(t('Defina uma nova senha mestra em Configurações.', 'Set a new master password in Settings.'), true); return; }
    setRoute({ page, folder: folderId }); setQuery(''); setSelection(new Set());
    location.hash = '#' + page + (folderId ? '/' + folderId : '');
    scroll?.scrollTo({ top: 0 });
  };
  const sync = async () => {
    if (syncing) return;
    setSyncing(true);
    try { await vault.sync(); }
    catch (e) { failure(e); }
    finally { setSyncing(false); }
  };
  useEffect(() => {
    const read = () => { setRoute(placement()); setSelection(new Set()); setQuery(''); };
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') void sync(); }, 45_000);
    const online = () => void sync();
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', online);
    return () => { clearInterval(id); window.removeEventListener('online', online); document.removeEventListener('visibilitychange', online); };
  }, [vault, syncing, t]);
  useEffect(() => {
    let active = true;
    void api<{ maxBytes: number }>('/storage/limits', { signal: vault.signal })
      .then(result => { if (active) setLimit(result.maxBytes); }).catch(e => { if (active && e instanceof RequestError && e.status === 401) onExpired(); });
    return () => { active = false; };
  }, [vault, onExpired]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(undefined), toast.error ? 8000 : 3800);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setContext(undefined); setMenu(undefined); setDrawer(false); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);
  useEffect(() => () => transfers.dispose(), [transfers]);

  const groups = useMemo(() => {
    const all = [...entries.values()];
    const active = all.filter(e => !isTrashed(entries, e));
    const files = all.filter((e): e is FileEntry => e.kind === 'file');
    const storage = files.reduce((acc, f) => {
      const n = cipherSize(f.size);
      acc.total += n;
      if (isTrashed(entries, f)) acc.trash += n;
      else {
        const kind = mediaKind(f);
        const type = kind === 'image' || kind === 'video' ? kind : ['pdf', 'text', 'document'].includes(kind) ? 'documents' : 'others';
        acc[type] += n;
      }
      return acc;
    }, { total: 0, image: 0, video: 0, documents: 0, others: 0, trash: 0 });
    return { active, all, files, storage };
  }, [entries]);
  const items = useMemo(() => {
    let filtered: Entry[];
    if (hasQuery) filtered = groups.active.filter(e => normal(e.name).includes(normal(query.trim())));
    else if (actualPage === 'trash') filtered = groups.all.filter(e => !!e.trash);
    else if (actualPage === 'drive') filtered = groups.active.filter(e => effectiveParent(entries, e) === parent);
    else if (actualPage === 'favorites') filtered = groups.active.filter(e => e.favorite);
    else if (actualPage === 'home' || actualPage === 'recent') filtered = groups.active.filter(e => e.kind === 'file');
    else if (['photos', 'videos', 'documents'].includes(actualPage)) filtered = groups.active.filter(e => {
      if (e.kind !== 'file') return false;
      const kind = mediaKind(e);
      return actualPage === 'photos' ? kind === 'image' : actualPage === 'videos' ? kind === 'video' : ['pdf', 'text', 'document'].includes(kind);
    });
    else filtered = [];
    const collator = new Intl.Collator(locale(prefs.language), { numeric: true, sensitivity: 'base' });
    const by = !hasQuery && (actualPage === 'home' || actualPage === 'recent' && sort === 'name') ? 'updated' : sort;
    const direction = by === 'updated' && (actualPage === 'home' || actualPage === 'recent' && sort === 'name') ? -1 : asc ? 1 : -1;
    const ordered = filtered.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return direction * (by === 'name' ? collator.compare(a.name, b.name)
        : by === 'size' ? (a.kind === 'file' ? a.size : 0) - (b.kind === 'file' ? b.size : 0)
        : a.updated - b.updated) || collator.compare(a.name, b.name);
    });
    return actualPage === 'home' && !hasQuery ? ordered.slice(0, 8) : ordered;
  }, [groups, actualPage, hasQuery, query, entries, parent, prefs.language, sort, asc]);

  const rootFolders = groups.active.filter(e => e.kind === 'folder' && effectiveParent(entries, e) === null).slice(0, 6);
  const toggle = (item: Entry) => {
    setSelection(old => { const next = new Set(old); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; });
    setAnchor(item.id);
  };
  const select = (item: Entry, event: MouseEvent) => {
    if (event.shiftKey && anchor) {
      const first = items.findIndex(e => e.id === anchor);
      const last = items.findIndex(e => e.id === item.id);
      if (first >= 0) { setSelection(new Set(items.slice(Math.min(first, last), Math.max(first, last) + 1).map(e => e.id))); return; }
    }
    if (event.ctrlKey || event.metaKey) toggle(item);
    else { setSelection(new Set([item.id])); setAnchor(item.id); }
  };
  const open = (item: Entry) => {
    if (isTrashed(entries, item)) { showModal({ kind: 'details', entry: item }); return; }
    if (item.kind === 'folder') navigate('drive', item.id);
    else setPreviewId(item.id);
  };
  const openContext = (items: Entry[], x: number, y: number) => {
    if (!items.length) return;
    setMenu(undefined);
    setSelection(new Set(items.map(e => e.id)));
    setContext({ items, x, y });
  };
  const showModal = (value: Modal) => {
    setModalError(''); setTargetFolder(null); setSearchFolder(''); setColor(value.kind === 'color' && value.entry.kind === 'folder' ? value.entry.color : 'blue');
    setContext(undefined); setMenu(undefined); setModal(value);
  };
  const patch = (item: Entry, value: Omit<Extract<Change, { type: 'edit' }>['patch'], 'updated'>): Change =>
    ({ type: 'edit', id: item.id, patch: { ...value, updated: Date.now() } });
  const update = async (changes: Change[], message?: string) => {
    try { await vault.mutate(changes); setSelection(new Set()); if (message) notify(message); }
    catch (e) { failure(e); }
  };
  const trash = (values: Entry[]) => void update(selectedRoots(entries, values).map(item => patch(item, { trash: Date.now() })), t('Itens movidos para a lixeira.', 'Items moved to trash.'));
  const restore = (values: Entry[]) => void update(values.map(item => patch(item, { trash: null, parent: ancestry(entries, item.parent).some(e => e.trash) ? null : effectiveParent(entries, item) })), t('Itens restaurados.', 'Items restored.'));
  const favorite = (values: Entry[]) => {
    const mark = !values.every(e => e.favorite);
    void update(values.map(item => patch(item, { favorite: mark })), mark ? t('Adicionado aos favoritos.', 'Added to starred.') : t('Removido dos favoritos.', 'Removed from starred.'));
  };

  const mergeIncoming = async (incoming: Dropped[]) => {
    const parentId = activeFolder;
    if (!incoming.length) return;
    const work = new Map(vault.state.entries);
    const folders = new Map<string, string>();
    const changes: Change[] = [];
    const queued: { file: File; name: string; parent: string | null }[] = [];
    for (const row of incoming) {
      let id = parentId;
      const labels = row.path.map(checked);
      const last = row.file ? labels.pop()! : undefined;
      let key = '';
      for (const label of labels) {
        key += '/' + normal(label);
        let next = folders.get(key);
        if (!next) {
          const found = [...work.values()].find(e => e.kind === 'folder' && e.parent === id && normal(e.name) === normal(label) && !isTrashed(work, e));
          if (found) next = found.id;
          else {
            uniqueName(work, label, id);
            const folder = newFolder(label, id);
            next = folder.id;
            changes.push({ type: 'put', entry: folder });
            work.set(folder.id, folder);
          }
          folders.set(key, next);
        }
        id = next;
      }
      if (row.file && last) {
        let name = last;
        let suffix = 1;
        const dot = last.lastIndexOf('.');
        const stem = dot > 0 ? last.slice(0, dot) : last;
        const ext = dot > 0 ? last.slice(dot) : '';
        while ([...work.values()].some(e => e.parent === id && !isTrashed(work, e) && normal(e.name) === normal(name)) ||
               queued.some(e => e.parent === id && normal(e.name) === normal(name))) {
          const addition = ` (${++suffix})`;
          name = stem.slice(0, Math.max(1, 240 - addition.length - ext.length)) + addition + ext.slice(0, 200);
        }
        queued.push({ file: row.file, name, parent: id });
      }
    }
    if (changes.length) await vault.mutate(changes);
    for (const row of queued) transfers.addFile(row.file, row.parent, max, row.name);
    if (queued.length) { setFloat(true); setCollapsed(false); }
    notify(t(`${queued.length} arquivo(s) na fila de envio.`, `${queued.length} file(s) queued for upload.`));
  };
  const choose = (folders: boolean) => {
    setMenu(undefined);
    const pick = folders ? directoryPicker(window) : undefined;
    if (pick) {
      void pick.call(window, { mode: 'read' }).then(readDirectory).then(mergeIncoming).catch(error => {
        if ((error as Error).name === 'AbortError') return;
        if ((error as Error).name === 'SecurityError' || (error as Error).name === 'NotAllowedError') folderPicker.current?.click();
        else failure(error);
      });
      return;
    }
    (folders ? folderPicker : filePicker).current?.click();
  };
  const handleFiles = (files: File[]) => void mergeIncoming(files.map(file => ({ file, path: (file.webkitRelativePath || file.name).split('/') }))).catch(failure);
  const drop = (e: DragEvent) => {
    if (!canEdit || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); setDrag(false); dragCount.current = 0;
    void readDrop(e.dataTransfer).then(mergeIncoming).catch(failure);
  };

  const download = async (values: Entry[]) => {
    try {
      if (values.length === 1 && values[0].kind === 'file') {
        const file = values[0];
        transfers.download(file, await destination(file.name, file.size));
      } else {
        const roots = selectedRoots(entries, values);
        const branch = subtree(entries, roots).filter(e => !isTrashed(entries, e));
        const rootIds = new Set(roots.map(item => item.id));
        const used = new Map<string, string>();
        const paths = new Map<string, string>();
        for (const item of branch) {
          const prefix = !rootIds.has(item.id) && item.parent ? paths.get(item.parent) : '';
          const base = (prefix ? prefix + '/' : '') + item.name;
          let value = base;
          let n = 1;
          while (used.has(value)) value = base + ' (' + ++n + ')';
          used.set(value, item.id);
          paths.set(item.id, value);
        }
        const files = branch.filter((e): e is FileEntry => e.kind === 'file').map(file => ({ file, path: paths.get(file.id)! }));
        const folders = branch.filter(e => e.kind === 'folder').map(e => paths.get(e.id)!);
        const name = (roots.length === 1 ? roots[0].name : 'CloudVault') + '.zip';
        const estimate = files.reduce((total, f) => total + f.file.size, 0) + branch.length * 1500 + 1024;
        transfers.zip(name, folders, files, await destination(name, estimate));
      }
      setFloat(true); setCollapsed(false);
    } catch (e) { if ((e as Error).name !== 'AbortError') failure(e); }
  };

  const move = async (values: Entry[], target: string | null) => {
    if (target && (entries.get(target)?.kind !== 'folder' || isTrashed(entries, entries.get(target)!))) throw new Error('TARGET_INVALID');
    const roots = selectedRoots(entries, values);
    if (roots.some(item => isDescendant(entries, target, item.id))) throw new Error('TARGET_INVALID');
    const names = new Set<string>();
    for (const item of roots) {
      uniqueName(entries, item.name, target, item.id);
      const name = normal(item.name);
      if (names.has(name)) throw new Error('NAME_EXISTS');
      names.add(name);
    }
    await vault.mutate(roots.map(item => patch(item, { parent: target })));
    notify(t('Itens movidos.', 'Items moved.'));
  };

  const copy = async (values: Entry[], target: string | null) => {
    const all = subtree(entries, selectedRoots(entries, values)).filter(item => !isTrashed(entries, item));
    if (target && (entries.get(target)?.kind !== 'folder' || isTrashed(entries, entries.get(target)!) || all.some(item => item.id === target))) throw new Error('TARGET_INVALID');
    const ids = new Map<string, string>();
    const work = new Map(entries);
    const roots = new Set(selectedRoots(entries, values).map(e => e.id));
    const changes: Change[] = [];
    const files: { file: FileEntry; name: string; parent: string | null }[] = [];
    const reserved = new Set<string>();
    for (const item of all) {
      const parent = roots.has(item.id) || !item.parent ? target : ids.get(item.parent) ?? target;
      let name = item.name;
      let number = 0;
      while (reserved.has(`${parent}/${normal(name)}`) || [...work.values()].some(e => e.parent === parent && normal(e.name) === normal(name) && !isTrashed(work, e))) {
        const tail = t(' — cópia', ' — copy') + (number ? ' ' + (number + 1) : '');
        const dot = item.kind === 'file' ? item.name.lastIndexOf('.') : -1;
        const extension = dot > 0 ? item.name.slice(dot).slice(0, 100) : '';
        name = (dot > 0 ? item.name.slice(0, dot) : item.name).slice(0, 240 - tail.length - extension.length) + tail + extension;
        number++;
      }
      reserved.add(`${parent}/${normal(name)}`);
      if (item.kind === 'folder') {
        const folder = newFolder(name, parent, item.color);
        ids.set(item.id, folder.id); work.set(folder.id, folder);
        changes.push({ type: 'put', entry: folder });
      } else if (!vault.isPurging(item.remote)) files.push({ file: item, name, parent });
    }
    if (changes.length) await vault.mutate(changes);
    for (const item of files) transfers.copy(item.file, item.name, item.parent, max);
    if (files.length) { setFloat(true); setCollapsed(false); }
    notify(t('Cópia iniciada.', 'Copy started.'));
  };

  const purge = async (values: Entry[]) => {
    const branch = subtree(entries, selectedRoots(entries, values)).reverse();
    let changes: Change[] = [];
    const allIds = new Set(branch.map(e => e.id));
    for (const item of branch) {
      if (item.kind === 'file') {
        const referenced = [...vault.state.entries.values()].some(e => e.kind === 'file' && e.remote === item.remote && !allIds.has(e.id));
        if (!referenced) {
          vault.markPurge(item.remote);
          try { await api('/storage/file/' + item.remote, { method: 'DELETE', signal: vault.signal }); }
          finally { vault.unmarkPurge(item.remote); }
        }
      }
      changes.push({ type: 'remove', id: item.id });
      if (changes.length >= 20) { await vault.mutate(changes); changes = []; }
    }
    if (changes.length) await vault.mutate(changes);
    notify(t('Itens excluídos permanentemente.', 'Items permanently deleted.'));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!modal || modal.kind === 'details') return;
    const nameInput = new FormData(event.currentTarget).get('name');
    setModalBusy(true); setModalError('');
    try {
      if (modal.kind === 'new') {
        const name = checked(String(nameInput ?? ''));
        uniqueName(entries, name, activeFolder);
        await vault.mutate([{ type: 'put', entry: newFolder(name, activeFolder, color) }]);
        notify(t('Pasta criada.', 'Folder created.'));
      }
      if (modal.kind === 'rename') {
        const name = checked(String(nameInput ?? ''));
        uniqueName(entries, name, effectiveParent(entries, modal.entry), modal.entry.id);
        await vault.mutate([patch(modal.entry, { name })]);
        notify(t('Nome atualizado.', 'Name updated.'));
      }
      if (modal.kind === 'color') await vault.mutate([patch(modal.entry, { color })]);
      if (modal.kind === 'move') await move(modal.items, targetFolder);
      if (modal.kind === 'copy') await copy(modal.items, targetFolder);
      if (modal.kind === 'purge') await purge(modal.items);
      setModal(undefined); setSelection(new Set());
    } catch (e) { setModalError(errorText(e, t)); }
    finally { setModalBusy(false); }
  };

  const modalTitle = modal?.kind === 'new' ? t('Nova pasta', 'New folder') : modal?.kind === 'rename' ? t('Renomear', 'Rename') :
    modal?.kind === 'color' ? t('Cor da pasta', 'Folder color') : modal?.kind === 'move' ? t('Mover para', 'Move to') :
    modal?.kind === 'copy' ? t('Copiar para', 'Copy to') : modal?.kind === 'purge' ? t('Excluir permanentemente?', 'Permanently delete?') : t('Detalhes do item', 'Item details');
  const selectedTrash = selectedItems.length > 0 && selectedItems.every(item => isTrashed(entries, item));
  const proposed = modal && (modal.kind === 'move' || modal.kind === 'copy') ? groups.active.filter(item => item.kind === 'folder' &&
    !modal.items.some(root => isDescendant(entries, item.id, root.id)) && (!searchFolder.trim() || normal(item.name).includes(normal(searchFolder.trim())))) : [];
  const used = groups.storage.total + journalBytes;
  const label = pages.find(row => row[0] === actualPage)!;
  const SortText: Record<Sort, string> = { name: t('Nome', 'Name'), size: t('Tamanho', 'Size'), updated: t('Data', 'Date') };
  const menuMotion = {
    initial: reduced ? false as const : { opacity: 0, y: -5 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -3 },
    transition: { duration: reduced ? 0 : .13 }
  };

  return <div className={'drive-shell ' + (compact ? 'compact' : '')}>
    <header className="drive-header">
      <div className="top-brand"><button className="icon-button sidebar-toggle" aria-label={t('Alternar menu lateral', 'Toggle sidebar')} onClick={() => { if (matchMedia('(max-width: 780px)').matches) setDrawer(!drawer); else setCompact(!compact); }}><Menu size={22} /></button><button className="brand-button" onClick={() => navigate('home')}><Brand /></button></div>
      <form className="drive-search" role="search" onSubmit={e => { e.preventDefault(); searchRef.current?.blur(); }}>
        <Search size={20} /><input disabled={recoveryRequired} ref={searchRef} value={query} aria-label={t('Pesquisar no CloudVault', 'Search CloudVault')} placeholder={t('Pesquisar no CloudVault', 'Search CloudVault')} onChange={e => { setQuery(e.target.value); setSelection(new Set()); }} />
        {query ? <button type="button" className="icon-button" aria-label={t('Limpar pesquisa', 'Clear search')} onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X size={16} /></button> : <kbd>Ctrl K</kbd>}
      </form>
      <div className="header-actions">
        <span className={'security-state ' + (offline ? 'offline' : '')}><span />{offline ? t('Sem conexão', 'Offline') : t('Cofre aberto', 'Vault unlocked')}</span>
        <button className="icon-button global-sync" aria-label={t('Sincronizar', 'Sync')} title={t('Sincronizar', 'Sync')} onClick={() => void sync()} disabled={syncing}><RefreshCw size={19} className={syncing ? 'spin' : ''} /></button>
        <div className="menu-anchor"><button className="profile-button" aria-label={t('Conta e segurança', 'Account and security')} title={profile.name} aria-expanded={menu === 'profile'} onClick={() => setMenu(menu === 'profile' ? undefined : 'profile')}><Avatar profile={profile} /><ChevronDown size={15} /></button>
          <AnimatePresence>{menu === 'profile' && <m.div className="popup profile-popup" {...menuMotion}>
            <div className="popup-account"><strong>{profile.name}</strong><small>{profile.username ? '@' + profile.username : t('Telegram conectado', 'Telegram connected')}</small></div>
            <button onClick={() => navigate('settings')}><Settings2 size={17} />{t('Configurações', 'Settings')}</button>
            <button onClick={lock}><LockKeyhole size={17} />{t('Bloquear cofre', 'Lock vault')}</button>
          </m.div>}</AnimatePresence>
        </div>
      </div>
    </header>
    {drawer && <button className="sidebar-scrim" aria-label={t('Fechar menu', 'Close menu')} onClick={() => setDrawer(false)} />}
    <aside className={'sidebar ' + (drawer ? 'drawer-open' : '')} aria-label={t('Navegação', 'Navigation')}>
      <div className="menu-anchor create-anchor">
        <button className="primary new-button" aria-expanded={menu === 'new'} onClick={() => setMenu(menu === 'new' ? undefined : 'new')} aria-label={t('Novo', 'New')} title={t('Novo', 'New')} disabled={recoveryRequired}><Plus size={23} /><span>{t('Novo', 'New')}</span><ChevronDown size={15} className="new-chevron" /></button>
        <AnimatePresence>{menu === 'new' && <m.div className="popup new-popup" {...menuMotion}>
          <button onClick={() => { if (!canEdit) navigate('drive'); showModal({ kind: 'new' }); }}><FolderPlus size={18} />{t('Nova pasta', 'New folder')}</button>
          <button onClick={() => choose(false)}><ArrowUpFromLine size={18} />{t('Upload de arquivos', 'Upload files')}</button>
          <button onClick={() => choose(true)}><FolderInput size={18} />{t('Upload de pasta', 'Upload folder')}</button>
        </m.div>}</AnimatePresence>
      </div>
      <nav>
        {pages.map(([id, Icon, pt, en], i) => <div className={i === 5 || i === 8 ? 'nav-group-start' : undefined} key={id}>
          <button title={t(pt, en)} aria-current={actualPage === id ? 'page' : undefined} className={actualPage === id ? 'nav-active' : ''} onClick={() => navigate(id)}><Icon size={19} strokeWidth={1.85} /><span>{t(pt, en)}</span></button>
        </div>)}
      </nav>
      <button className="side-storage" onClick={() => navigate('storage')} title={t('Armazenamento', 'Storage')}><span className="side-storage-icon"><Cloud size={17} /></span><span><strong>{sizeText(used, prefs.language)}</strong><small>{t('usados no CloudVault', 'used by CloudVault')}</small></span><ChevronRight size={15} /></button>
    </aside>
    <main className="main-scroll" ref={setScroll} onDragEnter={e => {
      if (canEdit && e.dataTransfer.types.includes('Files')) { e.preventDefault(); dragCount.current++; setDrag(true); }
    }} onDragLeave={e => { if (dragCount.current && e.dataTransfer.types.includes('Files')) { dragCount.current--; if (!dragCount.current) setDrag(false); } }}
      onDragOver={e => { if (canEdit && e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={drop}>
      <div className="drive-content">
        {reopenRecovery && <div className="callout recovery-reminder">
          <span>{t('Sua chave de recuperação ainda está disponível enquanto o cofre estiver aberto.', 'Your recovery key is still available while the vault is open.')}</span>
          <button className="secondary" onClick={reopenRecovery}>{t('Ver chave', 'View key')}</button>
        </div>}
        <AnimatePresence mode="wait" initial={false}><m.div key={hasQuery ? 'search' : actualPage + '/' + (parent ?? '')}
          initial={reduced ? false : { opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? undefined : { opacity: 0 }} transition={{ duration: reduced ? 0 : 0.15 }}>
          <div className="page-header">
            <div>
              {actualPage === 'drive' && !hasQuery && path.length > 0 ? <nav className="breadcrumbs" aria-label={t('Caminho da pasta', 'Folder path')}>
                <button onClick={() => navigate('drive')}>{t('Meu Drive', 'My Drive')}</button>{path.map((item, index) => <span key={item.id}><ChevronRight size={16} />{index === path.length - 1 ? <h1>{item.name}</h1> : <button onClick={() => navigate('drive', item.id)}>{item.name}</button>}</span>)}
              </nav> : <h1>{hasQuery ? t('Resultados da pesquisa', 'Search results') : t(label[2], label[3])}</h1>}
              <p>{hasQuery ? t(`${items.length} item(ns) para “${query.trim()}”`, `${items.length} item(s) for “${query.trim()}”`) : t(...guides[actualPage])}</p>
            </div>
            {!hasQuery && actualPage === 'trash' && items.length > 0 && <button className="danger-outline" onClick={() => showModal({ kind: 'purge', items })}><Trash2 size={17} />{t('Esvaziar lixeira', 'Empty trash')}</button>}
            {actualPage === 'drive' && !hasQuery && <button className="secondary page-upload" onClick={() => choose(false)}><CloudUpload size={18} />{t('Enviar arquivos', 'Upload files')}</button>}
          </div>
          {!hasQuery && actualPage === 'home' && <>
            <section className="home-banner">
              <div><span className="eyebrow"><ShieldCheck size={15} />{t('SEU ESPAÇO CRIPTOGRAFADO', 'YOUR ENCRYPTED WORKSPACE')}</span><h2>{t('Olá, ', 'Hello, ')}{profile.name.trim().split(/\s+/)[0] || 'Telegram'}.</h2><p>{t('Seus arquivos estão protegidos e prontos para acompanhar você.', 'Your files are protected and ready to go wherever you go.')}</p><button className="hero-button" onClick={() => choose(false)}><CloudUpload size={18} />{t('Enviar arquivos', 'Upload files')}</button></div>
              <div className="banner-graphic" aria-hidden><Cloud size={132} strokeWidth={1} /><span><LockKeyhole size={29} /></span></div>
            </section>
            <section className="quick-folders">
              <div className="section-header"><h2>{t('Pastas na raiz', 'Top-level folders')}</h2><button className="quiet text-link" onClick={() => navigate('drive')}>{t('Abrir Meu Drive', 'Open My Drive')}<ChevronRight size={17} /></button></div>
              {rootFolders.length ? <div className="quick-grid">{rootFolders.map(item => <button className="quick-folder" title={item.name} key={item.id} onClick={() => open(item)} onContextMenu={e => { e.preventDefault(); openContext([item], e.clientX, e.clientY); }}><EntryIcon item={item} /><strong>{item.name}</strong><ChevronRight size={15} /></button>)}</div> :
                <button className="quick-folder add-folder" onClick={() => showModal({ kind: 'new' })}><FolderPlus size={21} />{t('Criar pasta', 'Create folder')}</button>}
            </section>
          </>}
          {!hasQuery && actualPage === 'settings' ? <Suspense fallback={<Skeleton />}><Settings {...{ vault, profile, prefs, setPrefs, logout, onRecovery, notify, t, install }} /></Suspense> :
            !hasQuery && actualPage === 'transfers' ? <TransferPanel transfers={transfers} t={t} lang={prefs.language} /> :
            !hasQuery && actualPage === 'storage' ? <div className="storage-card">
              <span className="storage-emblem"><Cloud size={27} /></span><strong>{sizeText(used, prefs.language)}</strong><p>{t('Arquivos, lixeira e índice criptografado nas Mensagens Salvas.', 'Files, trash and encrypted index in Saved Messages.')}</p>
              <div className="storage-parts">{([
                ['image', t('Fotos', 'Photos'), '#5591fb'], ['video', t('Vídeos', 'Videos'), '#9276f8'], ['documents', t('Documentos', 'Documents'), '#48ae93'],
                ['others', t('Outros arquivos', 'Other files'), '#e3a05c'], ['trash', t('Lixeira', 'Trash'), '#cc6d84']
              ] as const).map(([key, name, color]) => <Meter key={key} title={name} amount={used ? groups.storage[key] * 100 / used : 0} label={sizeText(groups.storage[key], prefs.language)} color={color} />)}
                <Meter title={t('Índice', 'Index')} amount={used ? journalBytes * 100 / used : 0} label={sizeText(journalBytes, prefs.language)} color="#68829f" /></div>
              <div className="callout"><Info size={17} />{limit ? t(`Limite atual por arquivo antes da criptografia: ${sizeText(Math.floor(limit / wireBlock) * plainBlock, prefs.language)}. O Telegram pode aplicar limites de frequência e velocidade.`, `Current per-file limit before encryption: ${sizeText(Math.floor(limit / wireBlock) * plainBlock, prefs.language)}. Telegram may apply rate and speed limits.`) : t('O limite por arquivo é definido pelo Telegram e varia conforme a conta.', 'Telegram sets the upload limit per file for each account.')}</div>
            </div> :
            <section className="files-section">
              <div className="section-header" inert={selectedItems.length > 0}>
                <h2>{hasQuery ? t('Arquivos e pastas', 'Files and folders') : actualPage === 'home' ? t('Alterados recentemente', 'Recently modified') : t('Arquivos', 'Files')}</h2>
                <div className="file-controls">
                  <div className="menu-anchor"><button className="secondary sort-button" aria-expanded={menu === 'sort'} onClick={() => setMenu(menu === 'sort' ? undefined : 'sort')} title={t('Ordenar', 'Sort')}><ArrowDownWideNarrow size={17} /><span>{t('Ordenar', 'Sort')}</span><ChevronDown size={14} /></button>
                    <AnimatePresence>{menu === 'sort' && <m.div className="popup sort-popup" {...menuMotion}>
                      {(Object.keys(SortText) as Sort[]).map(key => <button key={key} onClick={() => { setSort(key); setAsc(key === sort ? !asc : key !== 'updated'); setMenu(undefined); }}>
                        {sort === key ? <ArrowUp size={16} style={{ transform: asc ? undefined : 'rotate(180deg)' }} /> : <span className="blank-icon" />}{SortText[key]}{sort === key && <Check size={16} className="menu-check" />}
                      </button>)}</m.div>}</AnimatePresence>
                  </div>
                  <div className="view-controls" aria-label={t('Visualização', 'View')}>
                    <button type="button" className="icon-button" aria-label={t('Lista', 'List')} aria-pressed={prefs.view === 'list'} onClick={() => setPrefs({ ...prefs, view: 'list' })}><LayoutList size={18} /></button>
                    <button type="button" className="icon-button" aria-label={t('Grade', 'Grid')} aria-pressed={prefs.view === 'grid'} onClick={() => setPrefs({ ...prefs, view: 'grid' })}><Grid2X2 size={17} /></button>
                  </div>
                </div>
              </div>
              {selectedItems.length > 0 && <div className="selection-bar">
                <button className="icon-button" aria-label={t('Limpar seleção', 'Clear selection')} onClick={() => setSelection(new Set())}><X size={17} /></button><strong>{t(`${selectedItems.length} selecionado(s)`, `${selectedItems.length} selected`)}</strong>
                {selectedTrash ? <><button className="icon-button" title={t('Restaurar', 'Restore')} onClick={() => restore(selectedItems)}><RefreshCw size={17} /></button><button className="icon-button negative" title={t('Excluir permanentemente', 'Permanently delete')} onClick={() => showModal({ kind: 'purge', items: selectedItems })}><Trash2 size={18} /></button></> :
                  <><button className="icon-button" title={t('Baixar', 'Download')} onClick={() => void download(selectedItems)}><ArrowDownToLine size={18} /></button>
                    <button className="icon-button" title={t('Mover', 'Move')} onClick={() => showModal({ kind: 'move', items: selectedItems })}><FolderInput size={18} /></button>
                    <button className="icon-button" title={t('Favoritos', 'Starred')} onClick={() => favorite(selectedItems)}><Star size={18} /></button>
                    <button className="icon-button" title={t('Mover para a lixeira', 'Move to trash')} onClick={() => trash(selectedItems)}><Trash2 size={18} /></button></>}
              </div>}
              {items.length ? <FileSurface items={items} view={prefs.view} selection={selection} t={t} lang={prefs.language} scroll={scroll}
                select={select} toggle={toggle} all={() => setSelection(items.every(item => selection.has(item.id)) ? new Set() : new Set(items.map(item => item.id)))} open={open}
                menu={openContext} moveDrop={(ids, folder) => void move(ids.map(id => entries.get(id)).filter((item): item is Entry => !!item), folder).then(() => setSelection(new Set())).catch(failure)} /> :
                <Empty icon={hasQuery ? <Search size={31} /> : actualPage === 'trash' ? <Trash2 size={31} /> : actualPage === 'favorites' ? <Star size={31} /> : <FolderClosed size={32} />}
                  title={hasQuery ? t('Nenhum resultado', 'No results') : actualPage === 'trash' ? t('A lixeira está vazia', 'Trash is empty') : actualPage === 'favorites' ? t('Nenhum favorito', 'No starred items') : t('Nenhum arquivo por aqui', 'No files here yet')}
                  detail={hasQuery ? t('Tente pesquisar por outro nome.', 'Try searching for a different name.') : canEdit ? t('Arraste e solte arquivos aqui ou faça um upload.', 'Drag and drop files here or start an upload.') : undefined}
                  action={canEdit && !hasQuery ? <button className="secondary" onClick={() => choose(false)}><CloudUpload size={18} />{t('Enviar arquivos', 'Upload files')}</button> : undefined} />}
            </section>}
        </m.div></AnimatePresence>
      </div>
      {drag && <div className="drop-overlay"><CloudUpload size={42} /><strong>{t('Solte aqui para enviar', 'Drop here to upload')}</strong></div>}
    </main>
    {menu && <button className="menu-scrim" aria-label={t('Fechar menu', 'Close menu')} onClick={() => setMenu(undefined)} />}
    <input hidden ref={filePicker} type="file" multiple onChange={e => { handleFiles([...e.target.files ?? []]); e.target.value = ''; }} />
    <input hidden ref={folderPicker} type="file" multiple {...{ webkitdirectory: '' }} onChange={e => { handleFiles([...e.target.files ?? []]); e.target.value = ''; }} />

    {context && <button className="context-scrim" aria-label={t('Fechar menu de contexto', 'Close context menu')} onClick={() => setContext(undefined)} onContextMenu={e => { e.preventDefault(); setContext(undefined); }} />}
    <AnimatePresence>{context && <m.div className="popup context-menu" style={{ left: Math.max(8, Math.min(context.x, window.innerWidth - 246)), top: Math.max(8, Math.min(context.y, window.innerHeight - ((context.items.every(item => isTrashed(entries, item)) ? 175 : 412)))) }}
        initial={reduced ? false : { opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .98 }} transition={menuMotion.transition}>
        {context.items.every(item => isTrashed(entries, item)) ? <>
          <button onClick={() => { restore(context.items); setContext(undefined); }}><RefreshCw size={17} />{t('Restaurar', 'Restore')}</button>
          <button className="negative" onClick={() => showModal({ kind: 'purge', items: context.items })}><Trash2 size={17} />{t('Excluir permanentemente', 'Permanently delete')}</button>
        </> : <>
          {context.items.length === 1 && <button onClick={() => { open(context.items[0]); setContext(undefined); }}><Eye size={17} />{t('Abrir', 'Open')}</button>}
          <button onClick={() => { void download(context.items); setContext(undefined); }}><ArrowDownToLine size={17} />{t('Baixar', 'Download')}</button>
          {context.items.length === 1 && <button onClick={() => showModal({ kind: 'rename', entry: context.items[0] })}><Pencil size={17} />{t('Renomear', 'Rename')}</button>}
          <button onClick={() => showModal({ kind: 'move', items: context.items })}><FolderInput size={17} />{t('Mover para', 'Move to')}</button>
          <button onClick={() => showModal({ kind: 'copy', items: context.items })}><Copy size={17} />{t('Copiar para', 'Copy to')}</button>
          <button onClick={() => { favorite(context.items); setContext(undefined); }}><Star size={17} />{context.items.every(item => item.favorite) ? t('Remover dos favoritos', 'Remove from starred') : t('Adicionar aos favoritos', 'Add to starred')}</button>
          {context.items.length === 1 && context.items[0].kind === 'folder' && <button onClick={() => showModal({ kind: 'color', entry: context.items[0] })}><span className="color-dot folder-blue" />{t('Alterar cor', 'Change color')}</button>}
          <button className="negative" onClick={() => { trash(context.items); setContext(undefined); }}><Trash2 size={17} />{t('Mover para lixeira', 'Move to trash')}</button>
        </>}
        {context.items.length === 1 && <button onClick={() => showModal({ kind: 'details', entry: context.items[0] })}><Info size={17} />{t('Detalhes', 'Details')}</button>}
      </m.div>}</AnimatePresence>
    {modal && <Dialog title={modalTitle} close={() => { if (!modalBusy) setModal(undefined); }} t={t}>
      {modal.kind === 'details' ? <>
        <div className="detail-head"><EntryIcon item={modal.entry} large /><div><strong>{modal.entry.name}</strong><small>{kindLabel(modal.entry, t)}</small></div></div>
        <dl className="details">
          <dt>{t('Local', 'Location')}</dt><dd>{[t('Meu Drive', 'My Drive'), ...ancestry(entries, modal.entry.parent).map(e => e.name)].join(' / ')}</dd>
          <dt>{t('Criado em', 'Created')}</dt><dd>{dateText(modal.entry.created, prefs.language)}</dd>
          <dt>{t('Modificado em', 'Modified')}</dt><dd>{dateText(modal.entry.updated, prefs.language)}</dd>
          <dt>{t('Criptografia', 'Encryption')}</dt><dd>AES-256-GCM</dd>
          {modal.entry.kind === 'file' && <><dt>{t('Tamanho', 'Size')}</dt><dd>{sizeText(modal.entry.size, prefs.language)}</dd><dt>SHA-256</dt><dd><code>{modal.entry.hash}</code></dd></>}
        </dl>
      </> : <form className="form-stack" onSubmit={submit}>
        {(modal.kind === 'new' || modal.kind === 'rename') && <label>{t('Nome', 'Name')}<input autoFocus required name="name" maxLength={240} defaultValue={modal.kind === 'rename' ? modal.entry.name : ''} /></label>}
        {(modal.kind === 'new' || modal.kind === 'color') && <div className="colors" aria-label={t('Cor da pasta', 'Folder color')}>{folderColors.map(value => <button type="button" className={'color-swatch folder-' + value} title={t(...colorLabels[value])} aria-label={t(...colorLabels[value])} aria-pressed={color === value} onClick={() => setColor(value)} key={value}>{color === value && <Check size={17} />}</button>)}</div>}
        {(modal.kind === 'move' || modal.kind === 'copy') && <>
          <input placeholder={t('Buscar pasta', 'Find a folder')} aria-label={t('Buscar pasta', 'Find a folder')} value={searchFolder} onChange={e => setSearchFolder(e.target.value)} />
          <div className="folder-options">
            <button type="button" className={targetFolder === null ? 'chosen' : ''} onClick={() => setTargetFolder(null)}><HardDrive size={17} />{t('Meu Drive', 'My Drive')}</button>
            {proposed.slice(0, 150).map(item => <button type="button" className={item.id === targetFolder ? 'chosen' : ''} key={item.id} onClick={() => setTargetFolder(item.id)}><FolderClosed size={17} />{ancestry(entries, item.parent).map(entry => entry.name).concat(item.name).join(' / ')}</button>)}
          </div>
        </>}
        {modal.kind === 'purge' && <p>{t(`${modal.items.length} item(ns) e seu conteúdo serão excluídos das Mensagens Salvas. Essa ação é irreversível.`, `${modal.items.length} item(s) and their contents will be deleted from Saved Messages. This action is irreversible.`)}</p>}
        {modalError && <div className="callout error" role="alert">{modalError}</div>}
        <div className="dialog-actions"><button className="secondary" type="button" disabled={modalBusy} onClick={() => setModal(undefined)}>{t('Cancelar', 'Cancel')}</button>
          <button className={modal.kind === 'purge' ? 'danger' : 'primary'} disabled={modalBusy}>{modalBusy && <Spinner />}{modal.kind === 'purge' ? t('Excluir definitivamente', 'Delete permanently') : modal.kind === 'copy' ? t('Copiar', 'Copy') : modal.kind === 'move' ? t('Mover', 'Move') : modal.kind === 'new' ? t('Criar pasta', 'Create folder') : t('Salvar', 'Save')}</button></div>
      </form>}
    </Dialog>}
    {preview?.kind === 'file' && <Suspense fallback={null}><Preview file={preview} items={items.filter((item): item is FileEntry => item.kind === 'file')} transfers={transfers}
      close={() => setPreviewId('')} open={item => setPreviewId(item.id)} download={item => void download([item])} t={t} signal={vault.signal} /></Suspense>}
    {float && actualPage !== 'transfers' && <TransferPanel floating collapsed={collapsed} toggle={() => setCollapsed(!collapsed)} close={() => setFloat(false)} transfers={transfers} t={t} lang={prefs.language} />}
    <AnimatePresence>{toast && <m.div key={toast.id} className={'toast ' + (toast.error ? 'toast-error' : '')} role={toast.error ? 'alert' : 'status'}
      initial={reduced ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={menuMotion.transition}><span>{toast.error ? <Info size={19} /> : <Check size={19} />}</span>{toast.value}<button className="icon-button" onClick={() => setToast(undefined)} aria-label={t('Fechar notificação', 'Dismiss notification')}><X size={16} /></button></m.div>}</AnimatePresence>
  </div>;
}
