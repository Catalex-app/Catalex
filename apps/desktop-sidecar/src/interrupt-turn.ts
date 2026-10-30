/** An interrupt acknowledgement is not a terminal result: keep consuming the
 * old turn before allowing another prompt into the persistent query. */
export async function interruptAndWait(
  interrupt: () => Promise<unknown>,
  completed: Promise<void>,
  timeoutMs = 10_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([interrupt(), completed]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Interrupt timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
