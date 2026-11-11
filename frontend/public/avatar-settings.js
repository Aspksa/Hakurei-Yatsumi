const $ = id => document.getElementById(id);
const avatar = $('yatsumiAvatar');
const image = avatar.querySelector('img');
const preview = $('avatarPreview');
const placeholder = $('avatarPreviewEmpty');
const fileInput = $('avatarFile');
const message = $('avatarMessage');
const endpoint = '/core/avatar';
const maxBytes = 10 * 1024 * 1024;
const accepted = new Set(['image/png', 'image/jpeg', 'image/webp']);
let objectUrl = null;

function setBusy(busy) {
  $('avatarChoose').disabled = busy;
  $('avatarReset').disabled = busy;
}
function showImage(url) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = url;
  avatar.hidden = preview.hidden = !url;
  document.documentElement.toggleAttribute('data-no-avatar', !url);
  placeholder.hidden = Boolean(url);
  for (const element of [image, preview]) {
    if (url) element.src = url;
    else element.removeAttribute('src');
  }
}
async function decodeImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const probe = new Image();
    probe.src = url;
    await probe.decode().catch(() => { throw new Error('Файл не является поддерживаемым изображением'); });
    if (probe.naturalWidth > 8192 || probe.naturalHeight > 8192) {
      throw new Error('Недопустимые размеры изображения (максимум 8192 × 8192)');
    }
    return url;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
async function loadAvatar() {
  const response = await fetch(endpoint + '?fallback=1');
  if (response.status === 204) return showImage(null);
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const blob = await response.blob();
  if (!accepted.has(blob.type)) throw new Error('Неверный формат сохранённого аватара');
  showImage(await decodeImage(blob));
}
$('avatarChoose').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  fileInput.value = '';
  if (!accepted.has(file.type)) { message.textContent = 'Поддерживаются PNG, JPEG и WebP.'; return; }
  if (file.size > maxBytes || file.size === 0) { message.textContent = 'Размер файла должен быть от 1 байта до 10 МБ.'; return; }
  setBusy(true);
  let url;
  try {
    url = await decodeImage(file);
    const response = await fetch(endpoint, { method: 'PUT', headers: { 'content-type': file.type }, body: file });
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(details.error || 'HTTP ' + response.status);
    }
    showImage(url);
    url = null;
    message.textContent = 'Аватар сохранён.';
  } catch (error) {
    message.textContent = 'Не удалось сохранить аватар: ' + error.message;
  } finally {
    if (url) URL.revokeObjectURL(url);
    setBusy(false);
  }
});
$('avatarReset').addEventListener('click', async () => {
  setBusy(true);
  try {
    const response = await fetch(endpoint, { method: 'DELETE' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    showImage(null);
    await loadAvatar();
    message.textContent = 'Загруженный аватар удалён.';
  } catch (error) {
    message.textContent = 'Не удалось обновить аватар: ' + error.message;
  } finally { setBusy(false); }
});
setBusy(true);
loadAvatar()
  .catch(error => { document.documentElement.setAttribute('data-no-avatar', ''); message.textContent = 'Не удалось загрузить аватар из проекта: ' + error.message; })
  .finally(() => setBusy(false));
