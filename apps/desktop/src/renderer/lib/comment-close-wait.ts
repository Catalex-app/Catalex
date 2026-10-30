import { ProjectExitCanceled } from "./project-chat-lifecycle";

export type CommentWaitChoices = {
  wait: () => void;
  discard: () => void;
  cancel: () => void;
};

/** Stop waiting for this close attempt without canceling or duplicating the save. */
export function waitForCommentsOnClose(
  saving: Promise<void>,
  show: (choices: CommentWaitChoices | null) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      show(null);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const wait = () => {
      if (settled) return;
      show(null);
      clearTimeout(timer);
      timer = setTimeout(() => {
        show({
          wait,
          discard: () => finish(),
          cancel: () => finish(new ProjectExitCanceled()),
        });
      }, 5_000);
    };
    wait();
    saving.then(
      () => finish(),
      (error) => finish(error),
    );
  });
}
