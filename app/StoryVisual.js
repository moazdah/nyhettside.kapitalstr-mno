// Story image with rights-cleared credit, or a designed fallback when no
// suitable licensed picture exists. Never an empty photo placeholder.
const TONES = { 'Norsk økonomi': 'economy', 'Økonomi': 'economy', 'Renter': 'rates', 'Markeder': 'markets', 'Selskaper': 'companies', 'Analyse': 'analysis' };

export function fallbackLabel(article) {
  const text = `${article?.tittel || ''}`;
  const figure = text.match(/(\d{1,3}(?:,\d{1,2})?)\s*(prosent|%)/i);
  return { tone: TONES[article?.seksjon] || 'markets', figure: figure ? `${figure[1]} %` : null, section: article?.seksjon || 'Kapitalstrøm' };
}

export default function StoryVisual({ article, className = '', caption = false }) {
  if (article?.bilde_url) {
    return (
      <figure className={`frontStoryImage ${className}`}>
        <img src={article.bilde_url} alt={article.image_alt || ''} loading="lazy" />
        {caption && article.bilde_kreditt ? <figcaption>{article.bilde_kreditt}</figcaption> : null}
      </figure>
    );
  }
  const label = fallbackLabel(article);
  return (
    <div className={`frontStoryImage storyFallback storyFallback-${label.tone} ${className}`} aria-hidden="true">
      <span className="storyFallbackSection">{label.section}</span>
      {label.figure ? <strong className="storyFallbackFigure">{label.figure}</strong> : <strong className="storyFallbackMark">K</strong>}
      <span className="storyFallbackBrand">Kapitalstrøm</span>
    </div>
  );
}
