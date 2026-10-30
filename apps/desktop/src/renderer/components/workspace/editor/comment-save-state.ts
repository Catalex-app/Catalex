// Transient UI state only. The storage queue remains the authority for retries
// and ordering. Subscribe per comment so typing never refreshes every card.
const pending = new Map<string, Set<symbol>>();
const listeners = new Map<string, Set<() => void>>();
const keyFor = (root: string, id: string) => JSON.stringify([root, id]);

export function isCommentSaving(root: string, id: string): boolean {
  return Boolean(pending.get(keyFor(root, id))?.size);
}

export function subscribeCommentSaving(
  root: string,
  id: string,
  listener: () => void,
): () => void {
  const key = keyFor(root, id);
  const group = listeners.get(key) ?? new Set();
  group.add(listener);
  listeners.set(key, group);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(key);
  };
}

export function trackCommentSaving(root: string, id: string) {
  const key = keyFor(root, id);
  const token = Symbol();
  return (saving: boolean) => {
    const group = pending.get(key) ?? new Set();
    const wasSaving = group.size > 0;
    if (saving) group.add(token);
    else group.delete(token);
    if (group.size) pending.set(key, group);
    else pending.delete(key);
    if (wasSaving !== group.size > 0)
      for (const listener of listeners.get(key) ?? []) listener();
  };
}
