import { type ReactNode } from 'react';

/**
 * Small, safe Markdown renderer for notes. It produces React elements only (never raw HTML),
 * and links are limited to http(s)/mailto so pasted content cannot run script.
 * Supported: # headings, **bold**, *italic*, `code`, ``` fenced code, - lists, 1. lists,
 * - [ ] / - [x] checklists, > quotes, [text](url), --- rules.
 */

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (m[1]) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{inline(tok.slice(2, -2), key)}</strong>);
    else if (m[3]) out.push(<em key={key}>{inline(tok.slice(1, -1), key)}</em>);
    else if (m[4]) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!;
      out.push(SAFE_URL.test(mm[2]!) ? <a key={key} href={mm[2]} target="_blank" rel="noopener noreferrer">{mm[1]}</a> : <span key={key}>{mm[1]}</span>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      blocks.push(<pre key={k++}><code>{buf.join('\n')}</code></pre>);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const Tag = (`h${level + 1}`) as 'h2' | 'h3' | 'h4';
      blocks.push(<Tag key={k++}>{inline(h[2]!, `h${k}`)}</Tag>);
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) { blocks.push(<hr key={k++} />); i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^>\s?/, ''));
      blocks.push(<blockquote key={k++}>{inline(buf.join(' '), `q${k}`)}</blockquote>);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/.test(lines[i]!) : /^\s*[-*]\s+/.test(lines[i]!))) {
        const raw = lines[i++]!.replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, '');
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(raw);
        items.push(
          task ? (
            <li key={items.length} className="md-task"><input type="checkbox" checked={task[1] !== ' '} readOnly aria-label={task[2]} /> <span>{inline(task[2]!, `t${k}-${items.length}`)}</span></li>
          ) : (
            <li key={items.length}>{inline(raw, `l${k}-${items.length}`)}</li>
          ),
        );
      }
      blocks.push(ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>);
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !/^(#{1,3}\s|```|>|---+\s*$|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i]!)) buf.push(lines[i++]!);
    blocks.push(<p key={k++}>{inline(buf.join('\n'), `p${k}`)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
