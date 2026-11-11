// Browser-local avatar selection. Binary files stay on the device in IndexedDB.
const $ = id => document.getElementById(id);
const avatar = $('yatsumiAvatar');
const image = avatar.querySelector('img');
const preview = $('avatarPreview');
const placeholder = $('avatarPreviewEmpty');
const fileInput = $('avatarFile');
const message = $('avatarMessage');
const DEFAULT_SRC = '/images/yatsumi-avatar.png';
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp']);
let objectUrl = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB недоступна в этом браузере'));
    const request = indexedDB.open('yatsumi-avatar', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('assets');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Ошибка открытия хранилища'));
  });
}
async function store(mode, operation) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('assets', mode);
      const request = operation(transaction.objectStore('assets'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Ошибка сохранения аватара'));
      transaction.onabort = () => reject(transaction.error || new Error('Операция отменена'));
    });
  } finally {
    db.close();
  }
}
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
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  image.src = DEFAULT_SRC;
  preview.src = DEFAULT_SRC;
  preview.hidden = false;
  placeholder.hidden = true;
  // The existing avatar load/error handlers hide it if the default image is absent.
}
async function loadSavedAvatar() {
  try {
    const blob = await store('readonly', assets => assets.get('current'));
    if (blob instanceof Blob && ACCEPTED.has(blob.type)) {
      showImage(URL.createObjectURL(blob));
      return;
    }
  } catch (error) {
    message.textContent = 'Локальное хранилище недоступно: ' + error.message;
  }
  showDefault();
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
  if (!ACCEPTED.has(file.type)) {
    message.textContent = 'Поддерживаются только PNG, JPEG и WebP.';
    return;
  }
  if (file.size > MAX_BYTES || file.size === 0) {
    message.textContent = 'Размер файла должен быть от 1 байта до 10 МБ.';
    return;
  }
  $('avatarChoose').disabled = true;
  try {
    await validateImage(file);
    await store('readwrite', assets => assets.put(file, 'current'));
    showImage(URL.createObjectURL(file));
    message.textContent = 'Аватар обновлён и сохранён в этом браузере.';
  } catch (error) {
    message.textContent = 'Не удалось сохранить аватар: ' + error.message;
  } finally {
    $('avatarChoose').disabled = false;
  }
});
$('avatarReset').addEventListener('click', async () => {
  $('avatarReset').disabled = true;
  try {
    await store('readwrite', assets => assets.delete('current'));
    showDefault();
    message.textContent = 'Выбранный аватар удалён. Восстановлен стандартный вариант (если установлен).';
  } catch (error) {
    message.textContent = 'Не удалось сбросить аватар: ' + error.message;
  } finally {
    $('avatarReset').disabled = false;
  }
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
