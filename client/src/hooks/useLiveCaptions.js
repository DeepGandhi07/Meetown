import { useCallback, useEffect, useState } from "react";

const MAX_CAPTIONS = 100;

/**
 * Receives normalized caption events from the Meetown signaling server.
 * The self-hosted speech-recognition/translation worker is a separate next step;
 * this hook deliberately does not call a browser/cloud speech API.
 *
 * Expected server event: `caption:result`
 * { id?, speakerId?, speakerName?, sourceLanguage?, targetLanguage?,
 *   originalText, translatedText?, isFinal?, timestamp? }
 */
export function useLiveCaptions({ socket, enabled, targetLanguage, sourceLanguage = "auto" }) {
  const [captions, setCaptions] = useState([]);
  const [connectionState, setConnectionState] = useState("waiting");

  useEffect(() => {
    if (!enabled || !socket) {
      setConnectionState("waiting");
      return undefined;
    }

    const handleCaption = (payload = {}) => {
      if (!payload.originalText && !payload.translatedText) return;
      if (payload.targetLanguage && payload.targetLanguage !== targetLanguage) return;
      if (sourceLanguage !== "auto" && payload.sourceLanguage && payload.sourceLanguage !== sourceLanguage) return;

      const caption = {
        id: payload.id || `${payload.speakerId || "speaker"}-${payload.timestamp || Date.now()}`,
        speakerId: payload.speakerId || "unknown",
        speakerName: payload.speakerName || "Participant",
        sourceLanguage: payload.sourceLanguage || "Unknown language",
        targetLanguage: payload.targetLanguage || targetLanguage,
        originalText: String(payload.originalText || "").slice(0, 2000),
        translatedText: String(payload.translatedText || "").slice(0, 2000),
        isFinal: payload.isFinal !== false,
        timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
        preview: false,
      };

      setCaptions((current) => {
        const sameCaptionIndex = current.findIndex((item) => item.id === caption.id);
        if (sameCaptionIndex >= 0) {
          const next = [...current];
          next[sameCaptionIndex] = { ...next[sameCaptionIndex], ...caption };
          return next;
        }
        if (!caption.isFinal) {
          const interimIndex = current.findIndex((item) => !item.isFinal && item.speakerId === caption.speakerId);
          if (interimIndex >= 0) {
            const next = [...current];
            next[interimIndex] = caption;
            return next;
          }
        }
        return [...current, caption].slice(-MAX_CAPTIONS);
      });
      setConnectionState("receiving");
    };

    const handleConnect = () => setConnectionState("waiting");
    socket.on("caption:result", handleCaption);
    socket.on("connect", handleConnect);
    socket.on("disconnect", handleConnect);

    return () => {
      socket.off("caption:result", handleCaption);
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleConnect);
    };
  }, [socket, enabled, targetLanguage, sourceLanguage]);

  const addPreviewCaption = useCallback(() => {
    const timestamp = new Date();
    setCaptions((current) => [...current, {
      id: `preview-${timestamp.getTime()}`,
      speakerId: "preview-speaker",
      speakerName: "Demo speaker",
      sourceLanguage: "German",
      targetLanguage,
      originalText: "Guten Morgen zusammen. Können wir mit dem Projektstatus beginnen?",
      translatedText: targetLanguage === "German"
        ? "Guten Morgen zusammen. Können wir mit dem Projektstatus beginnen?"
        : "Good morning everyone. Can we start with the project status?",
      isFinal: true,
      timestamp,
      preview: true,
    }].slice(-MAX_CAPTIONS));
  }, [targetLanguage]);

  const clearCaptions = useCallback(() => setCaptions([]), []);

  return { captions, connectionState, addPreviewCaption, clearCaptions };
}
