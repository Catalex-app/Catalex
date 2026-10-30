interface PersistedStore {
  persist: {
    getOptions: () => { name?: string };
    rehydrate: () => Promise<void> | void;
  };
}

const subscriptions = new Map<string, () => void>();

/** Keep each window's saved state current without broadcasting runtime state. */
export function synchronizePersistedStore(store: PersistedStore) {
  const key = store.persist.getOptions().name;
  if (!key) return;
  subscriptions.get(key)?.();
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === key &&
      (!event.storageArea || event.storageArea === window.localStorage)
    ) {
      // Zustand hydrates without persisting again, avoiding write/event loops.
      void store.persist.rehydrate();
    }
  };
  window.addEventListener("storage", onStorage);
  const onSaved = (event: Event) => {
    if ((event as CustomEvent<string>).detail === key)
      void store.persist.rehydrate();
  };
  window.addEventListener("workspace-state-saved", onSaved);
  const unlisten = window.catalex?.listen(
    "workspace-state-changed",
    (payload) => {
      if ((payload as { key: string }).key === key)
        void store.persist.rehydrate();
    },
  );
  subscriptions.set(key, () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("workspace-state-saved", onSaved);
    unlisten?.();
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
  });
}
