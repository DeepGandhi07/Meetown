import { useEffect, useRef } from "react";

/** A single participant tile: live video, or an initial when the camera is off. */
export default function VideoTile({
  stream,
  name,
  muted = false,
  hasVideo = true,
  micMuted = false,
  mirror = false,
  fit = "cover",
}) {
  const videoRef = useRef(null);
  const showVideo = Boolean(stream) && hasVideo;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !showVideo) return undefined;
    video.srcObject = stream;
    return () => {
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [stream, showVideo]);

  return (
    <div className="video-tile-media">
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={muted}
          style={{ objectFit: fit, transform: mirror ? "scaleX(-1)" : undefined }}
        />
      ) : (
        <div className="tile-avatar" aria-hidden="true">
          <span>{(name || "?").slice(0, 1).toUpperCase()}</span>
        </div>
      )}
      <span className="participant-name">
        {micMuted && (
          <i className="mic-off-badge" role="img" aria-label="Microphone muted">
            ⊘
          </i>
        )}
        {name}
      </span>
    </div>
  );
}
