import { CAPTION_LANGUAGES, SOURCE_LANGUAGE_OPTIONS } from "../../constants/languages.js";

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

export default function CaptionPanel({
  enabled,
  onEnabledChange,
  sourceLanguage,
  onSourceLanguageChange,
  targetLanguage,
  onTargetLanguageChange,
  captions,
  connectionState,
  onPreviewCaption,
  onClearCaptions,
}) {
  return (
    <div className="panel-content translate-panel">
      <div className="translate-status">
        <div className="translate-status-icon" aria-hidden="true">文<span>↔</span>A</div>
        <div className="translate-status-copy"><b>Meetown Captions</b><small>Multilingual captions workspace</small></div>
        <span className={`caption-state-badge state-${connectionState}`}>{connectionState === "receiving" ? "RECEIVING" : "NOT CONNECTED"}</span>
      </div>

      <div className="toggle-row">
        <div><b>Show captions</b><small>Display the latest caption on the meeting stage</small></div>
        <button type="button" className={`switch ${enabled ? "on" : ""}`} role="switch" aria-checked={enabled} onClick={() => onEnabledChange(!enabled)} aria-label="Toggle live captions"><span /></button>
      </div>

      <label className="field-label" htmlFor="source-language">Spoken language</label>
      <select id="source-language" className="dark-select" value={sourceLanguage} onChange={(event) => onSourceLanguageChange(event.target.value)}>
        {SOURCE_LANGUAGE_OPTIONS.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
      </select>
      <p className="caption-field-help">Speech detection runs on your configured self-hosted caption worker. Select a language to improve recognition when known.</p>

      <label className="field-label" htmlFor="target-language">Translate captions into</label>
      <select id="target-language" className="dark-select" value={targetLanguage} onChange={(event) => onTargetLanguageChange(event.target.value)}>
        {CAPTION_LANGUAGES.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
      </select>

      <div className="caption-transcript-card">
        <div className="caption-transcript-heading">
          <div><b>Live transcript</b><small>{captions.length} caption segment{captions.length === 1 ? "" : "s"}</small></div>
          <button type="button" className="text-button" onClick={onClearCaptions} disabled={!captions.length}>Clear</button>
        </div>
        {captions.length === 0 ? (
          <div className="caption-empty-state">
            <span className="caption-empty-icon">⌁</span>
            <b>Waiting for speech</b>
            <p>Speak for a few seconds with captions enabled. The self-hosted worker will transcribe and translate when the required model and language pair are installed.</p>
          </div>
        ) : (
          <div className="caption-transcript-list" aria-live="polite">
            {captions.slice(-20).map((caption) => (
              <article className="caption-transcript-item" key={caption.id}>
                <div className="caption-transcript-meta"><b>{caption.speakerName}</b><time>{formatTime(caption.timestamp)}</time>{caption.preview && <span className="caption-demo-tag">DEMO</span>}</div>
                {caption.translatedText && <p className="transcript-translation">{caption.translatedText}</p>}
                {caption.originalText && caption.originalText !== caption.translatedText && <p className="transcript-original">{caption.sourceLanguage}: {caption.originalText}</p>}
              </article>
            ))}
          </div>
        )}
      </div>

      <button type="button" className="secondary-button caption-preview-button" onClick={onPreviewCaption}>Preview sample caption</button>
      <div className="caption-privacy-note"><span>◇</span><p><b>Privacy-first by design</b><br />No browser speech-recognition or commercial translation API is called. Microphone audio is sent to your configured self-hosted caption worker for processing. Audio chunks are not intentionally saved by the worker. Verify your server and model configuration before using sensitive conversations.</p></div>
    </div>
  );
}
