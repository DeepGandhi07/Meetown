import { useEffect, useRef } from "react";

/** A single participant media tile. */
export default function VideoTile({ stream, name, muted = false }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream ?? null;
    return () => {
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [stream]);

  return (
    <div className="video-tile-media">
      <video ref={videoRef} autoPlay playsInline muted={muted} />
      <span className="participant-name">{name}</span>
    </div>
  );
}
