import type { Change, Entry, Folder } from './protocol';

export type Entries = Map<string, Entry>;

export function applyChanges(entries: Entries, changes: Change[]) {
  for (const change of changes) {
    if (change.type === 'put') {
      if (!entries.has(change.entry.id)) entries.set(change.entry.id, change.entry);
    } else if (change.type === 'remove') {
      entries.delete(change.id);
    } else {
      const old = entries.get(change.id);
      if (!old) continue;
      const { color, parent, ...patch } = change.patch;
      const moved = parent === undefined || isDescendant(entries, parent, old.id) ? old.parent : parent;
      entries.set(old.id, old.kind === 'folder'
        ? { ...old, ...patch, color: color ?? old.color, parent: moved }
        : { ...old, ...patch, parent: moved });
    }
  }
}

export function isDescendant(entries: Entries, id: string | null, ancestor: string) {
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    if (id === ancestor) return true;
    seen.add(id);
    id = entries.get(id)?.parent ?? null;
  }
  return false;
}

export function ancestry(entries: Entries, id: string | null) {
  const path: Folder[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    const folder: Entry | undefined = entries.get(id);
    if (folder?.kind !== 'folder') break;
    path.unshift(folder);
    seen.add(id);
    id = folder.parent;
  }
  return path;
}

export function isTrashed(entries: Entries, entry: Entry) {
  return !!entry.trash || ancestry(entries, entry.parent).some(folder => folder.trash);
}

export function effectiveParent(entries: Entries, entry: Entry) {
  return entry.parent && entries.get(entry.parent)?.kind === 'folder' ? entry.parent : null;
}

export function subtree(entries: Entries, roots: Entry[]) {
  const children = new Map<string, Entry[]>();
  for (const item of entries.values()) {
    if (item.parent) {
      const branch = children.get(item.parent) ?? [];
      branch.push(item);
      children.set(item.parent, branch);
    }
  }
  const stack = [...roots].reverse();
  const visited = new Map<string, Entry>();
  while (stack.length) {
    const item = stack.pop()!;
    if (visited.has(item.id)) continue;
    visited.set(item.id, item);
    if (item.kind === 'folder') {
      const branch = children.get(item.id) ?? [];
      for (let i = branch.length - 1; i >= 0; i--) stack.push(branch[i]);
    }
  }
  return [...visited.values()];
}
