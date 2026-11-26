import { appendFileSync } from "node:fs";
import { relative } from "node:path";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
} from "@playwright/test/reporter";

export default class GitHubFixmeReporter implements Reporter {
  private suite?: Suite;

  onBegin(_config: FullConfig, suite: Suite) {
    this.suite = suite;
  }

  onEnd(result: FullResult) {
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (!summary || !this.suite) return;

    const tests = this.suite.allTests();
    const fixmes = tests.flatMap((test) => {
      const fixme = test.annotations.find(({ type }) => type === "fixme");
      if (!fixme || test.outcome() !== "skipped") return [];

      const file = relative(process.cwd(), test.location.file);
      const title = test.title.replaceAll("\n", " ");
      const issue = fixme.description?.match(
        /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/,
      )?.[0];
      const tracking = issue ? ` ([tracking issue](${issue}))` : "";
      return [`- ${title} (${file}:${test.location.line})${tracking}`];
    });
    const flaky = tests.filter((test) => test.outcome() === "flaky").length;
    const seconds = Math.round(result.duration / 1000);

    appendFileSync(
      summary,
      [
        "### Browser shard",
        "",
        `Status: **${result.status}** in ${seconds} s. Tests: ${tests.length}. Flaky: ${flaky}.`,
        "",
        "#### Disabled browser tests",
        "",
        ...(fixmes.length ? fixmes : ["None in this shard."]),
        "",
        "",
      ].join("\n"),
    );
  }

  printsToStdio() {
    return false;
  }
}
