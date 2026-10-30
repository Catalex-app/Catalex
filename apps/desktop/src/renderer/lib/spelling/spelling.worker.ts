import { loadModule, type HunspellInstance } from "@farscrl/hunspell-wasm";
import enAff from "./dictionaries/en_US.aff?url";
import enDic from "./dictionaries/en_US.dic?url";
import gbAff from "./dictionaries/en_GB.aff?url";
import gbDic from "./dictionaries/en_GB.dic?url";
import type { SpellingLanguage, SpellingReply, SpellingRequest } from "./types";

const dictionaries = { "en-US": [enAff, enDic], "en-GB": [gbAff, gbDic] };
let factoryPromise: ReturnType<typeof loadModule> | undefined;
let checker: HunspellInstance | undefined;
let language: SpellingLanguage | undefined;
const cache = new Map<string, boolean>();

async function dictionary(next: SpellingLanguage) {
  if (checker && language === next) return checker;
  const factory = await (factoryPromise ??= loadModule());
  const buffers = await Promise.all(
    dictionaries[next].map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Could not load spelling dictionary");
      return new Uint8Array(await response.arrayBuffer());
    }),
  );
  const aff = factory.mountBuffer(buffers[0], "index.aff");
  const dic = factory.mountBuffer(buffers[1], "index.dic");
  try {
    checker?.dispose();
    checker = undefined;
    checker = factory.create(aff, dic);
    language = next;
    cache.clear();
    return checker;
  } finally {
    factory.unmount(aff);
    factory.unmount(dic);
  }
}

// Serialize initialization and language changes; no concurrent dictionary loads.
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<SpellingRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      const engine = await dictionary(request.language);
      const words =
        request.type === "suggest"
          ? engine.suggest(request.word).slice(0, 5)
          : request.words.filter((word) => {
              let correct = cache.get(word);
              if (correct === undefined) {
                correct = engine.spell(word);
                if (cache.size >= 10000)
                  cache.delete(cache.keys().next().value!);
                cache.set(word, correct);
              }
              return !correct;
            });
      self.postMessage({ id: request.id, words } satisfies SpellingReply);
    } catch (error) {
      self.postMessage({
        id: request.id,
        error: String(error),
      } satisfies SpellingReply);
    }
  });
};
