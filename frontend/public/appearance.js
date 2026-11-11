const T = window.YatsumiTheme;
const $ = id => document.getElementById(id);
const presets = [['Золото', '#d4af37'], ['Розовый', '#e58fb0'], ['Фиолетовый', '#a98bff'], ['Голубой', '#5cc8f0'], ['Изумруд', '#4fd1a1'], ['Красный', '#e2596b'], ['Серебро', '#cfd3da']];
let theme = T.readTheme(), av = T.readAvatar();

// ---- вкладки ----
const tabs = [...document.querySelectorAll('.tab')];
function selectTab(name) {
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name)), tab.tabIndex = tab.dataset.tab === name ? 0 : -1;
  for (const group of document.querySelectorAll('.panel-body>.group[data-tab]')) group.hidden = group.dataset.tab !== name;
  $('overlay').querySelector('.panel-body').scrollTop = 0;
}
for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  tab.addEventListener('keydown', event => {
    const i = tabs.indexOf(tab), step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    const next = tabs[(i + step + tabs.length) % tabs.length];
    next.focus(); selectTab(next.dataset.tab); event.preventDefault();
  });
}
selectTab('connection');

// ---- сегментные переключатели ----
function segmented(id, get, set) {
  const box = $(id);
  const sync = () => box.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === get())));
  box.addEventListener('click', event => { const b = event.target.closest('button'); if (b) { set(b.dataset.v); sync(); } });
  return sync;
}
const saveTheme = () => T.saveTheme(theme), saveAv = () => T.saveAvatar(av);

// ---- готовые темы ----
const presetBox = $('presets');
for (const preset of T.presets) {
  const b = Object.assign(document.createElement('button'), { type: 'button' });
  b.className = 'preset'; b.dataset.id = preset.id;
  b.style.setProperty('--sw', preset.theme.accent);
  b.innerHTML = '<i></i><span></span>';
  b.querySelector('span').textContent = preset.name;
  presetBox.append(b);
}
const sameTheme = (x, y) => ['accent', 'bg', 'shape', 'fill'].every(k => String(x[k]).toLowerCase() === String(y[k]).toLowerCase());
const syncPresets = () => presetBox.querySelectorAll('.preset').forEach(b =>
  b.setAttribute('aria-pressed', String(sameTheme(theme, T.presets.find(p => p.id === b.dataset.id).theme))));
presetBox.addEventListener('click', event => {
  const b = event.target.closest('.preset');
  if (!b) return;
  theme = { ...theme, ...T.presets.find(p => p.id === b.dataset.id).theme, font: theme.font };
  saveTheme(); syncAll();
});

// ---- оформление ----
const swatchBox = $('accentSwatches');
const picker = Object.assign(document.createElement('input'), { type: 'color', title: 'Свой цвет', ariaLabel: 'Свой цвет акцента' });
for (const [name, color] of presets) {
  const b = Object.assign(document.createElement('button'), { type: 'button', title: name, ariaLabel: name });
  b.className = 'swatch'; b.style.setProperty('--sw', color); b.dataset.color = color;
  swatchBox.append(b);
}
swatchBox.append(picker);
const syncSwatches = () => {
  swatchBox.querySelectorAll('.swatch').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === theme.accent.toLowerCase())));
  picker.value = theme.accent;
};
swatchBox.addEventListener('click', event => { const b = event.target.closest('.swatch'); if (b) { theme.accent = b.dataset.color; saveTheme(); syncSwatches(); } });
picker.addEventListener('input', () => { theme.accent = picker.value; saveTheme(); syncSwatches(); });
const syncers = [
  syncSwatches, syncPresets,
  segmented('bgMode', () => theme.bg, v => { theme.bg = v; saveTheme(); }),
  segmented('shapeMode', () => theme.shape, v => { theme.shape = v; saveTheme(); }),
  segmented('fillMode', () => theme.fill, v => { theme.fill = v; saveTheme(); }),
  segmented('avAnim', () => av.anim, v => { av.anim = v; saveAv(); }),
  segmented('avShape', () => av.shape, v => { av.shape = v; saveAv(); })
];
const font = $('fontScale');
font.addEventListener('input', () => { theme.font = Number(font.value); $('fontScaleOut').textContent = font.value + '%'; saveTheme(); });
$('lookReset').addEventListener('click', () => { theme = { ...T.themeDefaults }; saveTheme(); syncAll(); });

// ---- главная ----
let dash = T.readDash();
const dashBoxes = { dashClock: 'clock', dashSeconds: 'seconds', dashCalendar: 'calendar', dashTasks: 'tasks' };
for (const [id, key] of Object.entries(dashBoxes)) $(id).addEventListener('change', event => { dash[key] = event.target.checked; T.saveDash(dash); });
$('dashReset').addEventListener('click', () => { dash = { ...T.dashDefaults }; T.saveDash(dash); syncAll(); });

// ---- аватар ----
const size = $('avSize');
function currentSize() { return Number.isFinite(av.size) ? av.size : Math.round(document.getElementById('yatsumiAvatar').offsetWidth || 150); }
size.addEventListener('input', () => { av.size = Number(size.value); $('avSizeOut').textContent = size.value + ' px'; saveAv(); });
$('avShow').addEventListener('change', event => { av.show = event.target.checked; saveAv(); });
$('avSnap').addEventListener('change', event => { av.snap = event.target.checked; saveAv(); });
$('avGlow').addEventListener('change', event => { av.glow = event.target.checked; saveAv(); });
$('avResetPos').addEventListener('click', () => window.dispatchEvent(new Event('yatsumi:avatar-reset-position')));
$('avResetAll').addEventListener('click', () => { av = { ...T.avatarDefaults }; saveAv(); window.dispatchEvent(new Event('yatsumi:avatar-reset-position')); syncAll(); });

function syncAll() {
  for (const [id, key] of Object.entries(dashBoxes)) $(id).checked = dash[key] !== false;
  syncers.forEach(sync => sync());
  font.value = theme.font; $('fontScaleOut').textContent = theme.font + '%';
  $('avShow').checked = av.show !== false; $('avGlow').checked = av.glow !== false; $('avSnap').checked = av.snap !== false;
  size.value = currentSize(); $('avSizeOut').textContent = size.value + ' px';
}
$('settingsOpen').addEventListener('click', syncAll);
$('statusButton').addEventListener('click', syncAll);
$('emptyAction').addEventListener('click', syncAll);
syncAll();
