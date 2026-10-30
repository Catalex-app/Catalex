import { beforeEach, vi } from "vitest";

const storageData = new Map<string, string>();
const mockStorage = {
  getItem: vi.fn((key: string) => storageData.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storageData.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    storageData.delete(key);
  }),
  clear: vi.fn(() => {
    storageData.clear();
  }),
  key: vi.fn((index: number) => Array.from(storageData.keys())[index] ?? null),
  get length() {
    return storageData.size;
  },
};

const mockWebview = {
  setZoom: vi.fn(() => Promise.resolve()),
  onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
};

Object.defineProperty(window, "localStorage", {
  value: mockStorage,
  configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: mockStorage,
  configurable: true,
});

// Mock @/lib/desktop/core
vi.mock("@/lib/desktop/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

// Mock @/lib/desktop/event
vi.mock("@/lib/desktop/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Mock @/lib/desktop/webview
vi.mock("@/lib/desktop/webview", () => ({
  getCurrentWebview: vi.fn(() => mockWebview),
}));

// Mock @/lib/desktop/path
vi.mock("@/lib/desktop/path", () => ({
  configDir: vi.fn(),
  join: vi.fn((...args: string[]) => Promise.resolve(args.join("/"))),
}));

// Mock @/lib/desktop/fs
vi.mock("@/lib/desktop/fs", () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  readDir: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  copyFile: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
}));

// Mock @/lib/desktop/shell
vi.mock("@/lib/desktop/shell", () => ({
  Command: {
    create: vi.fn(),
  },
  open: vi.fn(() => Promise.resolve()),
}));

// Mock @/lib/desktop/dialog
vi.mock("@/lib/desktop/dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

// jsdom does not implement the browser APIs used by shared dialog sizing.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  );
});
