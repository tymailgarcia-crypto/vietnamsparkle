// Renders a help-chat answer (light markdown from Gemini) to HTML.
// Everything is escaped FIRST; only **bold**, numbered/dashed lists and
// relative links to our own pages (./name.html) are turned back into markup,
// so a model answer can never inject script, styles or off-site links.

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function inlineMarkdown(escaped) {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((\.\/[a-z-]+\.html(?:[?#][^)\s&]*)?)\)/g, '<a href="$2">$1</a>');
}

// Paragraphs, numbered lists and dashed lists — the only shapes the assistant
// is told to use.
export function renderAnswer(text) {
  const lines = escapeHtml(text).split(/\r?\n/);
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (numbered || bullet) {
      const kind = numbered ? "ol" : "ul";
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inlineMarkdown((numbered || bullet)[1])}</li>`);
    } else if (line) {
      closeList();
      out.push(`<p>${inlineMarkdown(line)}</p>`);
    } else {
      closeList();
    }
  }
  closeList();
  return out.join("");
}
