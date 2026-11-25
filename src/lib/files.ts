import { itemName, type Entry, type FileEntry, type Folder } from '../../shared/protocol';
import { effectiveParent, isTrashed, type Entries } from '../../shared/tree';

export const checked = (name: string) => {
  const parsed = itemName.safeParse(name);
  if (!parsed.success) throw new Error('NAME_INVALID');
  return parsed.data;
};
export const normal = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
export function uniqueName(entries: Entries, name: string, parent: string | null, except?: string) {
  if ([...entries.values()].some(e => e.id !== except && effectiveParent(entries, e) === parent && !isTrashed(entries, e) && normal(e.name) === normal(name))) throw new Error('NAME_EXISTS');
}
export const extension = (name: string) => name.lastIndexOf('.') > 0 ? name.split('.').at(-1)!.toLowerCase() : '';
export const mediaKind = (file: FileEntry) => {
  const ext = extension(file.name);
  if (file.mime.startsWith('image/') || /^(png|jpe?g|webp|gif|bmp|ico|avif|svg|heic|tiff?)$/.test(ext)) return 'image';
  if (file.mime.startsWith('video/') || /^(mp4|m4v|mov|webm|mkv|avi|mpeg|ogv)$/.test(ext)) return 'video';
  if (file.mime.startsWith('audio/') || /^(mp3|m4a|ogg|wav|flac|aac|opus)$/.test(ext)) return 'audio';
  if (file.mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (file.mime.startsWith('text/') || /^(txt|md|csv|tsv|log|json|xml|html?|css|js|ts|py|yaml|yml|ini|rtf)$/.test(ext)) return 'text';
  if (/^(docx?|odt|xlsx?|ods|pptx?|odp|epub|pages|numbers|key)$/.test(ext)) return 'document';
  if (/^(zip|rar|7z|gz|bz2|xz|tar|tgz|iso)$/.test(ext)) return 'archive';
  if (/^(exe|msi|bat|ps1|apk|app|sh|bin)$/.test(ext)) return 'executable';
  return 'file';
};

export function previewType(file: FileEntry) {
  const kind = mediaKind(file);
  const ext = extension(file.name);
  if (kind === 'image') {
    const supported: Record<string, string> = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml' };
    return supported[ext] ?? (/^image\/(avif|jpeg|png|webp|gif|bmp)$/.test(file.mime) ? file.mime : undefined);
  }
  if (kind === 'video') return ({ webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg', mp4: 'video/mp4', m4v: 'video/mp4' } as Record<string, string>)[ext] ?? (/^video\/(mp4|webm|ogg|quicktime)$/.test(file.mime) ? file.mime : undefined);
  if (kind === 'audio') return ({ m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac' } as Record<string, string>)[ext] ?? (/^audio\/(mp4|mpeg|wav|ogg|flac|webm|aac)$/.test(file.mime) ? file.mime : undefined);
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'text') return 'text/plain';
}

export const newFolder = (name: string, parent: string | null, color: Folder['color'] = 'blue'): Folder => {
  const now = Date.now();
  return { id: crypto.randomUUID(), kind: 'folder', name, parent, color, created: now, updated: now, trash: null, favorite: false };
};

export function selectedRoots(entries: Entries, selection: Entry[]) {
  const ids = new Set(selection.map(e => e.id));
  return selection.filter(item => {
    let parent = item.parent;
    while (parent) {
      if (ids.has(parent)) return false;
      parent = entries.get(parent)?.parent ?? null;
    }
    return true;
  });
}

type Dropped = { path: string[]; file?: File };
export async function readDrop(data: DataTransfer) {
  const files = [...data.files];
  const entries = [...data.items].filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return files.map(file => ({ path: [file.name], file } satisfies Dropped));
  const rows: Dropped[] = [];
  const visit = async (entry: FileSystemEntry, parent: string[]) => {
    const path = [...parent, entry.name];
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      rows.push({ path, file });
    } else if (entry.isDirectory) {
      rows.push({ path });
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, path);
      }
    }
  };
  for (const entry of entries) await visit(entry, []);
  return rows;
}

type ReadDirectory = FileSystemDirectoryHandle & { values: () => AsyncIterable<FileSystemHandle> };
export const directoryPicker = (window: Window) => (window as Window & {
  showDirectoryPicker?: (options: { mode: 'read' }) => Promise<ReadDirectory>;
}).showDirectoryPicker;

export async function readDirectory(root: ReadDirectory) {
  const rows: Dropped[] = [];
  const visit = async (folder: ReadDirectory, parent: string[]) => {
    const path = [...parent, folder.name];
    rows.push({ path });
    for await (const entry of folder.values()) {
      if (entry.kind === 'directory') await visit(entry as ReadDirectory, path);
      else rows.push({ path: [...path, entry.name], file: await (entry as FileSystemFileHandle).getFile() });
    }
  };
  await visit(root, []);
  return rows;
}

export type { Dropped };
