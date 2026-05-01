// Minimal markdown → HTML conversion (no external deps).
// Handles: # ## ### h1-h3, **bold**, *italic*, `code`, ```fences```, > blockquotes, - * lists, links.
export function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  md = md.replace(/```([\w-]*)\n([\s\S]*?)\n```/g, (_, lang, code) =>
    `<pre><code class="lang-${lang}">${esc(code)}</code></pre>`
  );
  const lines = md.split('\n');
  const out: string[] = [];
  let inList = false;
  let inQuote = false;
  let inTable = false;
  let tableHeaderDone = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.includes('<pre>') || line.includes('</pre>') || line.startsWith('<pre>')) {
      if (inList) { out.push('</ul>'); inList = false; }
      if (inQuote) { out.push('</blockquote>'); inQuote = false; }
      out.push(line);
      continue;
    }
    if (/^\s*\|.+\|\s*$/.test(line)) {
      if (!inTable) { out.push('<table>'); inTable = true; tableHeaderDone = false; }
      const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) {
        tableHeaderDone = true;
        continue;
      }
      const tag = !tableHeaderDone ? 'th' : 'td';
      out.push('<tr>' + cells.map(c => `<${tag}>${inlineFormat(esc(c))}</${tag}>`).join('') + '</tr>');
      continue;
    } else if (inTable) {
      out.push('</table>'); inTable = false; tableHeaderDone = false;
    }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      if (inList) { out.push('</ul>'); inList = false; }
      if (inQuote) { out.push('</blockquote>'); inQuote = false; }
      const level = Math.min(6, m[1].length);
      out.push(`<h${level}>${inlineFormat(esc(m[2]))}</h${level}>`);
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      if (inList) { out.push('</ul>'); inList = false; }
      if (inQuote) { out.push('</blockquote>'); inQuote = false; }
      out.push('<hr/>');
      continue;
    }
    if ((m = /^>\s?(.*)$/.exec(line))) {
      if (!inQuote) { out.push('<blockquote>'); inQuote = true; }
      out.push(`<p>${inlineFormat(esc(m[1]))}</p>`);
      continue;
    } else if (inQuote) {
      out.push('</blockquote>'); inQuote = false;
    }
    if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inlineFormat(esc(m[1]))}</li>`);
      continue;
    } else if (inList && line.trim() === '') {
      out.push('</ul>'); inList = false;
      continue;
    }
    if (line.trim() === '') {
      if (inList) { out.push('</ul>'); inList = false; }
      continue;
    }
    out.push(`<p>${inlineFormat(esc(line))}</p>`);
  }
  if (inList) out.push('</ul>');
  if (inQuote) out.push('</blockquote>');
  if (inTable) out.push('</table>');
  return out.join('\n');
}

function inlineFormat(s: string): string {
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return s;
}

export const MURMUR_MD_CSS = `
  .murmur-md h1 { font-family: var(--et-serif); font-size: 32px; margin: 0 0 12px; color: var(--et-ink); font-weight: 600; }
  .murmur-md h2 { font-family: var(--et-serif); font-size: 22px; margin: 28px 0 10px; color: var(--et-ink); font-weight: 600;
                  padding-bottom: 6px; border-bottom: 0.5px solid var(--et-line-2); }
  .murmur-md h3 { font-family: var(--et-serif); font-size: 18px; margin: 22px 0 8px; color: var(--et-ink); font-weight: 600; }
  .murmur-md h4 { font-size: 15px; margin: 16px 0 6px; color: var(--et-ink-soft); font-weight: 600; }
  .murmur-md p { margin: 8px 0; }
  .murmur-md ul { padding-left: 22px; margin: 8px 0; }
  .murmur-md li { margin: 4px 0; }
  .murmur-md blockquote {
    margin: 12px 0; padding: 10px 16px;
    background: var(--et-paper-2); border-left: 3px solid var(--et-orange);
    border-radius: 0 6px 6px 0; color: var(--et-ink-soft);
  }
  .murmur-md blockquote p { margin: 4px 0; }
  .murmur-md code {
    font-family: var(--et-mono); font-size: 13px;
    padding: 1px 6px; border-radius: 4px;
    background: var(--et-paper-2); color: var(--et-orange-2);
  }
  .murmur-md pre {
    background: var(--et-paper); border: 0.5px solid var(--et-line-2);
    border-radius: 8px; padding: 12px 14px; overflow-x: auto;
    margin: 12px 0;
  }
  .murmur-md pre code { background: transparent; padding: 0; color: var(--et-ink); }
  .murmur-md hr { border: 0; border-top: 0.5px solid var(--et-line-2); margin: 24px 0; }
  .murmur-md strong { color: var(--et-ink); font-weight: 600; }
  .murmur-md em { color: var(--et-ink-soft); }
  .murmur-md table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 13px; }
  .murmur-md th, .murmur-md td {
    border: 0.5px solid var(--et-line-2);
    padding: 8px 12px; text-align: left;
  }
  .murmur-md th { background: var(--et-paper-2); font-weight: 600; }
  .murmur-md a { color: var(--et-orange-2); text-decoration: none; border-bottom: 0.5px dashed currentColor; }
`;
