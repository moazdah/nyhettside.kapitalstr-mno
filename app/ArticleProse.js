'use client';

function safeHttpUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function renderInline(text, keyPrefix) {
  const value = String(text || '');
  const regex = /\[([^\]]{1,180})\]\((https?:\/\/[^\s)]+)\)/g;
  const nodes = [];
  let last = 0;
  let match;
  let index = 0;

  while ((match = regex.exec(value)) !== null) {
    if (match.index > last) nodes.push(value.slice(last, match.index));
    const url = safeHttpUrl(match[2]);
    if (url) {
      nodes.push(
        <a
          key={`${keyPrefix}-${index++}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="articleSourceLink"
        >
          {match[1]}
        </a>
      );
    } else {
      nodes.push(match[1]);
    }
    last = match.index + match[0].length;
  }

  if (last < value.length) nodes.push(value.slice(last));
  return nodes;
}

export default function ArticleProse({ body, className = 'prose' }) {
  const paragraphs = String(body || '').split(/\n\s*\n/).filter((p) => p.trim());

  return (
    <div className={className}>
      {paragraphs.map((paragraph, index) => {
        const value = paragraph.trim();
        const aiPrefix = 'AI-vurdering:';
        if (value.toLowerCase().startsWith(aiPrefix.toLowerCase())) {
          const analysis = value.slice(aiPrefix.length).trim();
          return (
            <aside className="aiAssessment" key={index}>
              <div className="aiAssessmentLabel">AI-vurdering</div>
              <p>{renderInline(analysis, `ai${index}`)}</p>
            </aside>
          );
        }
        return <p key={index}>{renderInline(paragraph, `p${index}`)}</p>;
      })}
    </div>
  );
}
