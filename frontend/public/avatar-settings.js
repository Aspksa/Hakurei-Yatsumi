// The owner avatar is stored in the project, not in browser storage or Cloud.ru.
const $ = id => document.getElementById(id);
const avatar = $('yatsumiAvatar');
const image = avatar.querySelector('img');
const preview = $('avatarPreview');
const placeholder = $('avatarPreviewEmpty');
const fileInput = $('avatarFile');
const message = $('avatarMessage');
const DEFAULT_SRC = '/images/yatsumi-avatar.png';
const ENDPOINT = '/core/avatar';
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp']);
let objectUrl = null;

function showImage(src) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = src.startsWith('blob:') ? src : null;
  image.src = src;
  preview.src = src;
  preview.hidden = false;
  placeholder.hidden = true;
  avatar.hidden = false;
}
function showDefault() {
  showImage(DEFAULT_SRC);
}
async function loadSavedAvatar() {
  try {
    const response = await fetch(ENDPOINT, { cache: 'no-store' });
    if (response.status === 404) { showDefault(); return; }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const blob = await response.blob();
    if (!ACCEPTED.has(blob.type)) throw new Error('Неверный формат сохранённого аватара');
    showImage(URL.createObjectURL(blob));
  } catch (error) {
    showDefault();
    message.textContent = 'Не удалось загрузить аватар из проекта: ' + error.message;
  }
}
function validateImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const probe = new Image();
    probe.onload = () => {
      URL.revokeObjectURL(url);
      if (!probe.naturalWidth || !probe.naturalHeight || probe.naturalWidth > 8192 || probe.naturalHeight > 8192) {
        reject(new Error('Недопустимые размеры изображения (максимум 8192 × 8192)'));
      } else resolve();
    };
    probe.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Файл не является поддерживаемым изображением')); };
    probe.src = url;
  });
}
$('avatarChoose').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  fileInput.value = '';
  if (!ACCEPTED.has(file.type)) { message.textContent = 'Поддерживаются PNG, JPEG и WebP.'; return; }
  if (file.size > MAX_BYTES || file.size === 0) { message.textContent = 'Размер файла должен быть от 1 байта до 10 МБ.'; return; }
  $('avatarChoose').disabled = true;
  try {
    await validateImage(file);
    const response = await fetch(ENDPOINT, { method: 'PUT', headers: { 'content-type': file.type }, body: file });
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(details.error || 'HTTP ' + response.status);
    }
    showImage(URL.createObjectURL(file));
    message.textContent = 'Аватар сохранён в папке проекта. Он останется после перезапуска и доступен в другом браузере на этом компьютере.';
  } catch (error) {
    message.textContent = 'Не удалось сохранить аватар: ' + error.message;
  } finally { $('avatarChoose').disabled = false; }
});
$('avatarReset').addEventListener('click', async () => {
  $('avatarReset').disabled = true;
  try {
    const response = await fetch(ENDPOINT, { method: 'DELETE' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    showDefault();
    message.textContent = 'Загруженный аватар удалён из проекта. Восстановлен стандартный (если он установлен).';
  } catch (error) {
    message.textContent = 'Не удалось сбросить аватар: ' + error.message;
  } finally { $('avatarReset').disabled = false; }
});
image.addEventListener('error', () => {
  if (image.src.endsWith(DEFAULT_SRC)) {
    avatar.hidden = true;
    preview.hidden = true;
    placeholder.hidden = false;
  }
});
window.addEventListener('pagehide', () => { if (objectUrl) URL.revokeObjectURL(objectUrl); });
loadSavedAvatar();
