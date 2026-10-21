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
  statusMessage,
  onPreviewCaption,
  onClearCaptions,
}) {
  return (
    <div className="panel-content translate-panel">
      <div className="translate-status">
        <div className="translate-status-icon" aria-hidden="true">文<span>↔</span>A</div>
        <div className="translate-status-copy"><b>Meetown Captions</b><small>Multilingual captions workspace</small></div>
        <span className={`caption-state-badge state-${connectionState}`}>{{ receiving: "RECEIVING", unavailable: "UNAVAILABLE" }[connectionState] || "LISTENING"}</span>
      </div>

      {connectionState === "unavailable" && (
        <p className="error caption-unavailable" role="status">
          {statusMessage || "Captions are temporarily unavailable."} The meeting is not affected; captions resume automatically.
        </p>
      )}

      <div className="toggle-row">
        <div><b>Show captions</b><small>Display the latest caption on the meeting stage</small></div>
        <button type="button" className={`switch ${enabled ? "on" : ""}`} role="switch" aria-checked={enabled} onClick={() => onEnabledChange(!enabled)} aria-label="Toggle live captions"><span /></button>
      </div>

      <label className="field-label" htmlFor="source-language">Spoken language</label>
      <select id="source-language" className="dark-select" value={sourceLanguage} onChange={(event) => onSourceLanguageChange(event.target.value)}>
        {SOURCE_LANGUAGE_OPTIONS.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
      </select>
      <p className="caption-field-help">Select the language being spoken to improve recognition, or leave it on auto-detect.</p>

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
            <p>Speak for a few seconds with captions enabled. Captions appear for everyone who has them switched on, in their own language.</p>
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
      <div className="caption-privacy-note"><span>◇</span><p><b>Privacy-first by design</b><br />While captions are on and your microphone is unmuted, short audio chunks are sent through the Meetown server to the speech provider it is configured with (a cloud service or your own caption worker). Audio is not stored by Meetown. Turn captions off for sensitive conversations.</p></div>
    </div>
  );
}
