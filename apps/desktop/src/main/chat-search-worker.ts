import { parentPort, workerData } from "node:worker_threads";
import { searchSavedChat } from "./chat-checkpoints";

const { directory, tabId, query } = workerData;
void searchSavedChat(directory, tabId, query).then(
  (result) => parentPort?.postMessage(result),
  (error) => parentPort?.postMessage({ error: String(error) }),
);
