/** Cut every URL in a message to its host: provider URLs carry API keys. */
export function redactUrls(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s"')]+/gi, (url, scheme: string) => {
    try {
      return `${scheme}://${new URL(url).hostname}/[redacted]`;
    } catch {
      return `${scheme}://[redacted]`;
    }
  });
}
