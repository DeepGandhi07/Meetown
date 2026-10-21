import { useEffect } from "react";

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 2;
const samplesPerChunk = TARGET_SAMPLE_RATE * CHUNK_SECONDS;

function resampleTo16k(floatSamples, inputRate) {
  if (inputRate === TARGET_SAMPLE_RATE) return floatSamples;
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(floatSamples.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), floatSamples.length);
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += floatSamples[j];
    output[i] = sum / Math.max(1, end - start);
  }
  return output;
}

function toPcm16(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return buffer;
}

/** Captures the local microphone only while captions are enabled. Audio is sent
 * to the self-hosted Meetown caption worker through the room signaling server. */
export function useCaptionAudio({
  stream,
  socket,
  enabled,
  sourceLanguage,
  targetLanguage,
  epoch = 0, // bumps when the socket re-joins the room, so preferences are re-sent
}) {
  useEffect(() => {
    const track = stream?.getAudioTracks()?.[0];
    if (
      !enabled ||
      !track ||
      !socket?.connected ||
      track.readyState !== "live"
    ) {
      socket?.emit("caption:set-preferences", {
        enabled: false,
        sourceLanguage,
        targetLanguage,
      });
      return undefined;
    }

    let context;
    let source;
    let processor;
    let chunks = [];
    let sampleCount = 0;
    let stopped = false;
    let sending = false;

    const flushChunk = () => {
      if (stopped || sending || sampleCount < samplesPerChunk) return;
      const pcm = new Float32Array(samplesPerChunk);
      let written = 0;
      while (written < samplesPerChunk && chunks.length) {
        const first = chunks[0];
        const take = Math.min(first.length, samplesPerChunk - written);
        pcm.set(first.subarray(0, take), written);
        written += take;
        if (take === first.length) chunks.shift();
        else chunks[0] = first.subarray(take);
      }
      sampleCount -= written;
      sending = true;
      // The timeout guarantees a lost reply can never stall caption capture.
      socket.timeout(20000).emit(
        "caption:audio-chunk",
        { audio: toPcm16(pcm) },
        (timeoutError, response = {}) => {
          sending = false;
          if (timeoutError) console.warn("Caption chunk timed out");
          else if (response?.ok === false)
            console.warn("Caption audio chunk was rejected:", response.error);
          flushChunk();
        },
      );
    };

    socket.emit("caption:set-preferences", {
      enabled: true,
      sourceLanguage,
      targetLanguage,
    });

    try {
      context = new AudioContext();
      source = context.createMediaStreamSource(new MediaStream([track]));
      processor = context.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (event) => {
        if (stopped || track.muted || !track.enabled) return;
        const input = event.inputBuffer.getChannelData(0);
        const resampled = resampleTo16k(input, context.sampleRate);
        let energy = 0;
        for (let i = 0; i < resampled.length; i += 1)
          energy += resampled[i] * resampled[i];
        if (energy / Math.max(1, resampled.length) < 0.000025) return;
        chunks.push(resampled);
        sampleCount += resampled.length;
        flushChunk();
      };

      source.connect(processor);
      // Keep the processing graph alive without routing microphone audio to speakers.
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      processor.connect(silentGain);
      silentGain.connect(context.destination);

      return () => {
        stopped = true;
        processor.onaudioprocess = null;
        source.disconnect();
        processor.disconnect();
        context.close().catch(() => {});
        socket.emit("caption:set-preferences", {
          enabled: false,
          sourceLanguage,
          targetLanguage,
        });
      };
    } catch (error) {
      console.error("Unable to start caption audio capture:", error);
      return undefined;
    }
  }, [stream, socket, enabled, sourceLanguage, targetLanguage, epoch]);

}
