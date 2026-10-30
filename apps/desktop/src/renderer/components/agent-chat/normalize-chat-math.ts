/** Convert TeX delimiters before Markdown consumes their backslash escapes. */
export function normalizeChatMath(source: string): string {
  // Protect fenced/indented code, inline code, and escaped backslashes first.
  // Unclosed fences/backticks stay literal while a response is streaming.
  const tokens =
    /(^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2[ \t]*(?=\n|$)|(?![\s\S])))|(^ {0,3}(?:`{3,}|~{3,})[^\n]*$)|(^ {4}[^\n]*(?:\n|$))|(`+)([^`]|(?!\5)`)*\5|(`+[^\n]*$)|(\\\\)|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/gm;
  return source.replace(
    tokens,
    (
      match,
      fence,
      _marker,
      fenceStart,
      indent,
      ticks,
      _body,
      unfinished,
      escaped,
      inline,
      display,
    ) => {
      if (fence || fenceStart || indent || ticks || unfinished || escaped)
        return match;
      if (inline !== undefined) return `$${inline}$`;
      return `\n\n$$\n${display.trim()}\n$$\n\n`;
    },
  );
}
