import { useState } from 'react';
import { avatarSrc } from '../api.js';

// A 42 profile photo, loaded through the server's /api/avatar proxy (cdn.intra.42.fr refuses
// anonymous requests for user photos). Falls back to `fallback` (e.g. initials) when the
// student has no photo or it fails to load, instead of the browser's broken-image + alt text.
const Avatar = ({ url, alt, className, fallbackClassName, fallback, style, fallbackStyle, as: Fallback = 'div' }) => {
  // Tracks WHICH url failed, so a different url (list re-render, new student) gets a fresh try.
  const [failedUrl, setFailedUrl] = useState(null);

  if (url && failedUrl !== url) {
    return (
      <img
        className={className}
        src={avatarSrc(url)}
        alt={alt}
        style={style}
        loading="lazy"
        onError={() => setFailedUrl(url)}
      />
    );
  }
  return (
    <Fallback className={`${className} ${fallbackClassName}`} style={fallbackStyle}>
      {fallback}
    </Fallback>
  );
};

export default Avatar;
