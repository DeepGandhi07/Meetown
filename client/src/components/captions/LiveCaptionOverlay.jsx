import { useEffect, useRef } from "react";

/** On-stage captions, separate from the transcript/history panel. */
export default function LiveCaptionOverlay({ captions, enabled }) {
  const latest = captions[captions.length - 1];
  const containerRef = useRef(null);

  useEffect(() => {
    containerRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [latest?.id]);

  if (!enabled || !latest) return null;

  return (
    <section className="live-caption-overlay" aria-live="polite" aria-atomic="true" aria-label="Live captions">
      <div className="live-caption-header">
        <span className="caption-wave" aria-hidden="true"><i /><i /><i /><i /></span>
        <span>{latest.speakerName}</span>
        <span className="caption-language-pair">{latest.sourceLanguage} → {latest.targetLanguage}</span>
        {latest.preview && <span className="caption-demo-tag">DEMO</span>}
      </div>
      {latest.translatedText && <p className="live-caption-translated">{latest.translatedText}</p>}
      {latest.originalText && latest.originalText !== latest.translatedText && (
        <p className="live-caption-original">Original: {latest.originalText}</p>
      )}
      <span className="caption-overlay-anchor" ref={containerRef} />
    </section>
  );
}
