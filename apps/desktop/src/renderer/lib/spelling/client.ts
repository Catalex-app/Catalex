import type { SpellingLanguage, SpellingReply, SpellingRequest } from "./types";

/** One lazy worker per renderer, released when no enabled editor uses it. */
class SpellingClient {
  private worker?: Worker;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (words: string[]) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private getWorker() {
    if (!this.worker) {
      const worker = new Worker(
        new URL("./spelling.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.onmessage = (event: MessageEvent<SpellingReply>) => {
        const reply = event.data;
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id);
        clearTimeout(pending.timer);
        if ("error" in reply) pending.reject(new Error(reply.error));
        else pending.resolve(reply.words);
      };
      worker.onerror = () =>
        this.dispose(new Error("Spell checker failed to start"));
      this.worker = worker;
    }
    return this.worker;
  }

  private request(
    data: Omit<SpellingRequest, "id"> & { words?: string[]; word?: string },
  ) {
    return new Promise<string[]>((resolve, reject) => {
      const worker = this.getWorker();
      const id = ++this.nextId;
      const timer = setTimeout(
        () => this.dispose(new Error("Spell checker timed out")),
        30000,
      );
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...data, id });
    });
  }

  check(words: string[], language: SpellingLanguage) {
    return words.length
      ? this.request({ type: "check", words, language })
      : Promise.resolve([]);
  }

  suggest(word: string, language: SpellingLanguage) {
    return this.request({ type: "suggest", word, language });
  }

  dispose(error = new Error("Spell checker stopped")) {
    this.worker?.terminate();
    this.worker = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
let shared: SpellingClient | undefined;
let users = 0;
export function retainSpellingClient() {
  const client = (shared ??= new SpellingClient());
  users++;
  return {
    client,
    release() {
      if (--users === 0) {
        client.dispose();
        shared = undefined;
      }
    },
  };
}
