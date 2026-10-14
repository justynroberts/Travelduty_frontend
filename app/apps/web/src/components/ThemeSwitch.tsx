import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'auto';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('td-theme');
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

/** Segmented Light / Dark / Auto control; the inline script in index.html applies it before paint. */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === 'auto') localStorage.removeItem('td-theme');
      else localStorage.setItem('td-theme', theme);
    } catch {
      /* storage unavailable: theme still applies for this visit */
    }
  }, [theme]);

  return (
    <div role="radiogroup" aria-label="Colour theme" className="flex rounded-md border border-line bg-surface p-0.5 text-xs">
      {(['light', 'dark', 'auto'] as const).map((t) => (
        <button
          key={t}
          role="radio"
          aria-checked={theme === t}
          onClick={() => setTheme(t)}
          className={`min-h-8 rounded-sm px-2.5 capitalize transition-colors duration-150 ${theme === t ? 'bg-raised text-text font-medium' : 'text-muted hover-fine:text-text'}`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
