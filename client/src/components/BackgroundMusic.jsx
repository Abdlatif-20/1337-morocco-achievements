import { useEffect, useRef, useState } from 'react';

// Autoplay-with-sound is blocked by every browser until the visitor has interacted with the
// page at least once — there's no way around that from JS. So: try to play immediately on
// mount, and if the browser rejects it (NotAllowedError), fall back to starting on the
// visitor's very first click/keypress anywhere on the page, which still feels "automatic"
// since it doesn't require touching this button specifically.
const BackgroundMusic = () => {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    audio.volume = 0.4;

    audio.play()
      .then(() => setPlaying(true))
      .catch(() => {
        const startOnInteraction = () => {
          audio.play().then(() => setPlaying(true)).catch(() => {});
        };
        document.addEventListener('click', startOnInteraction, { once: true });
        document.addEventListener('keydown', startOnInteraction, { once: true });
        return () => {
          document.removeEventListener('click', startOnInteraction);
          document.removeEventListener('keydown', startOnInteraction);
        };
      });
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play().then(() => setPlaying(true)).catch(() => {});
    }
  };

  return (
    <>
      <audio ref={audioRef} src="/background-music.mp3" loop />
      <button
        type="button"
        className="music-toggle-btn"
        onClick={toggle}
        title={playing ? 'Pause music' : 'Play music'}
        aria-label={playing ? 'Pause background music' : 'Play background music'}
      >
        {playing ? '⏸' : '▶'}
      </button>
    </>
  );
};

export default BackgroundMusic;
