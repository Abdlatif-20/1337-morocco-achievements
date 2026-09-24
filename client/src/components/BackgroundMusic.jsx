import { useRef, useState } from 'react';

// Music is stopped by default — the user starts it explicitly by clicking the button.
// No autoplay attempt, no global interaction listeners.
const BackgroundMusic = () => {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);

  const toggle = () => {
    const audio = audioRef.current;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.volume = 0.4;
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
