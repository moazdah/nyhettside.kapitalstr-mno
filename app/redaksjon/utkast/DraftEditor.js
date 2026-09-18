'use client';

import { useRef, useState } from 'react';
import ArticleProse from '../../ArticleProse';
import AdminSubmitButton from '../AdminSubmitButton';

function findLinkAt(text, start, end) {
  const regex = /\[([^\]]{1,180})\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const from = match.index;
    const to = match.index + match[0].length;
    const overlaps = (start >= from && start <= to) || (end >= from && end <= to) || (start <= from && end >= to);
    if (overlaps) {
      return { from, to, label: match[1], url: match[2], raw: match[0] };
    }
  }
  return null;
}

function validUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export default function DraftEditor({ article, action }) {
  const [title, setTitle] = useState(article.tittel || '');
  const [dek, setDek] = useState(article.undertittel || '');
  const [section, setSection] = useState(article.seksjon || 'Markeder');
  const [author, setAuthor] = useState(article.forfatter || 'Kapitalstrøm');
  const [body, setBody] = useState(article.brodtekst || '');
  const [imageUrl, setImageUrl] = useState(article.bilde_url || '');
  const [imageCredit, setImageCredit] = useState(article.bilde_kreditt || '');
  const [linkText, setLinkText] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkMessage, setLinkMessage] = useState('');
  const textareaRef = useRef(null);
  const selectionRef = useRef({ start: 0, end: 0 });

  function syncSelection() {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    selectionRef.current = { start, end };

    const existing = findLinkAt(body, start, end);
    if (existing) {
      setLinkText(existing.label);
      setLinkUrl(existing.url);
      setLinkMessage('Eksisterende lenke valgt.');
      return;
    }

    if (end > start) {
      setLinkText(body.slice(start, end));
      setLinkMessage('Valgt tekst kan gjøres til lenke.');
    } else {
      setLinkMessage('');
    }
  }

  function applyLink() {
    const el = textareaRef.current;
    if (!el) return;

    const { start, end } = selectionRef.current;
    const existing = findLinkAt(body, start, end);
    const url = validUrl(linkUrl);
    if (!url) {
      setLinkMessage('Lim inn en gyldig http/https-URL.');
      return;
    }

    const selected = end > start ? body.slice(start, end) : '';
    const label = String(linkText || selected || existing?.label || '').trim();
    if (!label) {
      setLinkMessage('Marker teksten som skal være klikkbar, eller skriv lenketeksten.');
      return;
    }

    const replacement = `[${label}](${url})`;
    const from = existing ? existing.from : start;
    const to = existing ? existing.to : end;
    const next = body.slice(0, from) + replacement + body.slice(to);
    setBody(next);
    setLinkText(label);
    setLinkUrl(url);
    setLinkMessage(existing ? 'Lenken er oppdatert.' : 'Lenken er lagt til.');

    requestAnimationFrame(() => {
      el.focus();
      const cursor = from + replacement.length;
      el.setSelectionRange(cursor, cursor);
      selectionRef.current = { start: cursor, end: cursor };
    });
  }

  function removeLink() {
    const el = textareaRef.current;
    if (!el) return;

    const { start, end } = selectionRef.current;
    const existing = findLinkAt(body, start, end);
    if (!existing) {
      setLinkMessage('Sett markøren inne i lenken du vil fjerne.');
      return;
    }

    const next = body.slice(0, existing.from) + existing.label + body.slice(existing.to);
    setBody(next);
    setLinkText(existing.label);
    setLinkUrl('');
    setLinkMessage('Lenken er fjernet, teksten er beholdt.');

    requestAnimationFrame(() => {
      el.focus();
      const cursor = existing.from + existing.label.length;
      el.setSelectionRange(cursor, cursor);
      selectionRef.current = { start: cursor, end: cursor };
    });
  }

  return (
    <>
      <form action={action} className="adminEditForm">
        <input type="hidden" name="id" value={article.id}/>

        <label className="adminField">
          <b>Tittel</b>
          <input name="tittel" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>

        <label className="adminField">
          <b>Undertittel / ingress</b>
          <textarea name="undertittel" value={dek} onChange={(e) => setDek(e.target.value)} rows={3}/>
        </label>

        <div className="adminEditGrid">
          <label className="adminField">
            <b>Seksjon</b>
            <select name="seksjon" value={section} onChange={(e) => setSection(e.target.value)}>
              <option>Markeder</option>
              <option>Selskaper</option>
              <option>Økonomi</option>
              <option>Renter</option>
              <option>Analyse</option>
              <option>Kalender</option>
            </select>
          </label>

          <label className="adminField">
            <b>Forfatter</b>
            <input name="forfatter" value={author} onChange={(e) => setAuthor(e.target.value)}/>
          </label>
        </div>

        <div className="adminField">
          <b>Brødtekst</b>
          <div className="linkEditor">
            <div>
              <label>Lenketekst</label>
              <input value={linkText} onChange={(e) => setLinkText(e.target.value)} placeholder="f.eks. Finansavisen"/>
            </div>
            <div>
              <label>Lenke-URL</label>
              <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://..."/>
            </div>
            <button type="button" className="secondary" onClick={applyLink}>Legg til / oppdater lenke</button>
            <button type="button" className="secondary" onClick={removeLink}>Fjern lenke</button>
          </div>
          <small className="editorHelp">Marker ordet eller kilden i brødteksten. Lim inn URL-en og trykk «Legg til / oppdater lenke». Sett markøren i en eksisterende lenke for å redigere eller fjerne den.</small>
          {linkMessage ? <small className="editorMessage">{linkMessage}</small> : null}
          <textarea
            ref={textareaRef}
            name="brodtekst"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onSelect={syncSelection}
            onClick={syncSelection}
            onKeyUp={syncSelection}
            required
            rows={24}
            className="articleTextEditor"
          />
        </div>

        <div className="adminEditGrid imageEditGrid">
          <label className="adminField">
            <b>Bilde-URL</b>
            <input
              name="bilde_url"
              type="url"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://..."
            />
          </label>
          <label className="adminField">
            <b>Bildekreditering</b>
            <input
              name="bilde_kreditt"
              value={imageCredit}
              onChange={(e) => setImageCredit(e.target.value)}
              placeholder="Foto: ..."
            />
          </label>
        </div>

        <AdminSubmitButton pendingText="Lagrer …">Lagre endringer</AdminSubmitButton>
        <small className="editorHelp">Lagring publiserer ikke saken.</small>
      </form>

      <div className="sectionKicker draftPreviewTitle">Forhåndsvisning</div>
      <article className="articleBody draftPreview">
        <div className="eyebrow">{section}</div>
        <h1>{title || 'Uten tittel'}</h1>
        {dek ? <p className="articleDek">{dek}</p> : null}
        <div className="articleMeta">
          <div><b>Av {author || 'Kapitalstrøm'}</b><br/><span>Privat utkast</span></div>
        </div>
        <figure>
          {imageUrl
            ? <img src={imageUrl} alt="" style={{ width: '100%', height: 'auto', display: 'block' }}/>
            : <div className="photoPlaceholder articlePhoto"><span>INGEN BILDE VALGT</span></div>}
          <figcaption>{imageCredit || (imageUrl ? 'Bildekreditering mangler.' : 'Legg inn bilde-URL og kreditering over.')}</figcaption>
        </figure>
        <ArticleProse body={body}/>
      </article>
    </>
  );
}
