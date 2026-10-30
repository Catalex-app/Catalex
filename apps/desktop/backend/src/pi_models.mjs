import { writeFileSync } from "node:fs";

// Pi resolves enabledModels patterns, provider identities, and ordering itself.
export default function catalexModels(pi) {
  pi.on("session_start", (_event, context) => {
    const output = process.env.CATALEX_PI_MODELS;
    delete process.env.CATALEX_PI_MODELS;
    if (!Array.isArray(context.scopedModels)) {
      writeFileSync(
        output,
        JSON.stringify({
          error:
            "Pi does not expose scoped models. Update Pi, then check again.",
        }),
      );
      return;
    }
    const models = context.scopedModels.length
      ? context.scopedModels.map(({ model }) => model)
      : context.modelRegistry.getAvailable();
    writeFileSync(
      output,
      JSON.stringify({
        models: models.map(
          ({
            id,
            provider,
            name,
            reasoning,
            contextWindow,
            thinkingLevelMap,
          }) => ({
            id,
            provider,
            name,
            reasoning,
            contextWindow,
            thinkingLevelMap,
            isDefault:
              context.model?.id === id && context.model?.provider === provider,
          }),
        ),
      }),
    );
  });
}
