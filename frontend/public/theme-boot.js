// Применяет сохранённое оформление до отрисовки страницы. Хранится только в браузере.
(() => {
  const THEME_KEY = 'yatsumi-theme-v1', AV_KEY = 'yatsumi-avatar-prefs-v1';
  const themeDefaults = { accent: '#d4af37', bg: 'black', shape: 'round', fill: 'metal', font: 100 };
  const avatarDefaults = { show: true, size: null, shape: 'free', glow: true };
  const shapes = {
    straight: { box: '0px', btn: '0px', round: '0px', field: '0px', bubble: '0px' },
    soft: { box: '14px', btn: '10px', round: '10px', field: '8px', bubble: '12px' },
    round: { box: '22px', btn: '999px', round: '50%', field: '12px', bubble: '18px' }
  };
  const avShapes = { free: ['0', 'none'], square: ['0', 'cover'], rounded: ['24%', 'cover'], circle: ['50%', 'cover'] };
  const backgrounds = {
    black: base => ({ base: '#000', ink: hsl(base, 35, 4), raised: hsl(base, 35, 7) }),
    graphite: () => ({ base: '#121214', ink: '#1b1b1e', raised: '#252529' }),
    midnight: () => ({ base: '#070b16', ink: '#0d1322', raised: '#151d33' })
  };
  function read(key, defaults) {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return { ...defaults }; }
  }
  function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
  function hexToHsl(hex) {
    const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    let h = 0, s = 0;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
  }
  function hsl(hue, s, l) { return `hsl(${hue} ${s}% ${l}%)`; }
  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; })
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  }
  function applyTheme(theme) {
    const root = document.documentElement, set = (name, value) => root.style.setProperty(name, value);
    const accent = /^#[0-9a-f]{6}$/i.test(theme.accent) ? theme.accent : themeDefaults.accent;
    const [h, s0] = hexToHsl(accent), s = Math.min(100, Math.max(s0, 12));
    set('--gold', accent);
    set('--gold-light', hsl(h, Math.min(100, s + 10), 78));
    set('--gold-pale', hsl(h, Math.min(100, s + 20), 93));
    set('--gold-deep', hsl(h, s, 33));
    set('--text', hsl(h, Math.min(s, 60), 84));
    set('--muted', hsl(h, Math.min(s, 32), 62));
    set('--line', hsl(h, Math.min(s, 45), 16));
    set('--line-strong', hsl(h, Math.min(s, 45), 30));
    set('--metal', `linear-gradient(135deg,${hsl(h, s, 48)} 0%,${hsl(h, s, 62)} 20%,${hsl(h, s, 93)} 38%,${accent} 56%,${hsl(h, s, 50)} 78%,${hsl(h, s, 72)} 100%)`);
    set('--on-gold', luminance(accent) > .22 ? '#120c00' : '#fff');
    const bg = (backgrounds[theme.bg] || backgrounds.black)(h);
    set('--black', bg.base); set('--ink', bg.ink); set('--ink-raised', bg.raised);
    root.style.background = bg.base;
    const shape = shapes[theme.shape] || shapes.round;
    for (const key of Object.keys(shape)) set('--r-' + key, shape[key]);
    root.dataset.fill = theme.fill === 'flat' ? 'flat' : 'metal';
    const k = Math.min(1.3, Math.max(.85, Number(theme.font) / 100 || 1));
    root.style.fontSize = k === 1 ? '' : `calc(clamp(15px,.9rem + .1vw,17px) * ${k})`;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg.base);
  }
  function applyAvatar(prefs) {
    const root = document.documentElement, set = (name, value) => root.style.setProperty(name, value);
    root.dataset.av = prefs.show === false ? 'off' : 'on';
    const [radius, frame] = avShapes[prefs.shape] || avShapes.free;
    set('--av-radius', radius); root.dataset.avFrame = frame;
    set('--av-glow', prefs.glow === false ? '0' : '1');
    if (Number.isFinite(prefs.size)) set('--av-size', prefs.size + 'px'); else root.style.removeProperty('--av-size');
  }
  const api = { themeDefaults, avatarDefaults, readTheme: () => read(THEME_KEY, themeDefaults), readAvatar: () => read(AV_KEY, avatarDefaults),
    saveTheme(t) { write(THEME_KEY, t); applyTheme(t); }, saveAvatar(a) { write(AV_KEY, a); applyAvatar(a); window.dispatchEvent(new Event('resize')); } };
  window.YatsumiTheme = api;
  applyTheme(api.readTheme());
  applyAvatar(api.readAvatar());
})();
