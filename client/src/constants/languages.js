/** Language choices shown by Meetown's caption controls. */
export const CAPTION_LANGUAGES = [
  { value: "English", label: "English", locale: "en-US" },
  { value: "German", label: "German (Deutsch)", locale: "de-DE" },
  { value: "Hindi", label: "Hindi (हिन्दी)", locale: "hi-IN" },
  { value: "French", label: "French (Français)", locale: "fr-FR" },
  { value: "Spanish", label: "Spanish (Español)", locale: "es-ES" },
  { value: "Portuguese", label: "Portuguese (Português)", locale: "pt-PT" },
  { value: "Japanese", label: "Japanese (日本語)", locale: "ja-JP" },
];

export const SOURCE_LANGUAGE_OPTIONS = [
  { value: "auto", label: "Auto-detect" },
  ...CAPTION_LANGUAGES.map(({ value, label }) => ({ value, label })),
];
