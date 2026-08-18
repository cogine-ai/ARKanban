import { Fragment } from "react";

/**
 * Renders untrusted transcript text.
 *
 * Message bodies are attacker-controlled: an agent can be told to emit markup,
 * scripts, or markdown injection. So the text goes in as React text nodes and
 * nothing else — no Markdown pass, no `dangerouslySetInnerHTML`, nothing that
 * would let content become structure.
 *
 * Search highlighting works on character offsets and splits into sibling nodes.
 * Building a highlighted string by concatenating `<mark>` around matches would
 * reintroduce exactly the injection this avoids.
 */
export function TranscriptText({ text, highlight }: { text: string; highlight?: string }) {
  const needle = highlight?.trim() ?? "";
  if (needle.length === 0) return <>{text}</>;

  const segments: Array<{ text: string; match: boolean }> = [];
  const haystack = text.toLowerCase();
  const lowered = needle.toLowerCase();
  let cursor = 0;

  while (cursor <= text.length) {
    const found = haystack.indexOf(lowered, cursor);
    if (found === -1) {
      if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (found > cursor) segments.push({ text: text.slice(cursor, found), match: false });
    segments.push({ text: text.slice(found, found + needle.length), match: true });
    cursor = found + needle.length;
  }

  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={index}>{segment.match ? <mark>{segment.text}</mark> : segment.text}</Fragment>
      ))}
    </>
  );
}
