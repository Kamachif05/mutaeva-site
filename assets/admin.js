const configBase = (window.MUTAEVA_CONFIG?.apiBase || '').replace(/\/$/, '');
if (configBase && new URL(configBase).origin !== location.origin) location.replace(`${configBase}/admin/`);

let csrf = '';
let data = null;
let savedPrices = '';
let dirty = false;
let saving = false;
const loginPanel = document.getElementById('login-panel');
const editor = document.getElementById('editor');
const login = document.getElementById('login-form');
const form = document.getElementById('price-form');
const message = document.getElementById('message');
const saveButton = document.getElementById('save');
const logoutButton = document.getElementById('logout');
const reloadButton = document.getElementById('reload');
const search = document.getElementById('search');
const date = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' });
const errors = {
  invalid_credentials: 'Логин или пароль не подошёл. Проверьте данные.',
  too_many_attempts: 'Слишком много попыток входа. Попробуйте через 15 минут.',
  login_required: 'Сессия завершена. Войдите снова. Несохранённые изменения останутся в этой вкладке.',
  conflict: 'Цены уже изменены в другой вкладке. Загрузите сохранённые цены и повторите ваши изменения.',
  invalid_prices: 'Проверьте цены: нужны целые числа от 0 до 1 000 000 рублей.',
  csrf_denied: 'Не удалось подтвердить сессию. Выйдите и войдите снова.',
  server_error: 'Сервер не смог сохранить цены. Изменения остались в форме. Попробуйте ещё раз.'
};
function notify(text, error = false) { message.textContent = text; message.dataset.error = String(error); }
async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000), ...options }); }
  catch { throw new Error('network'); }
  let result;
  try { result = await response.json(); } catch { throw new Error('network'); }
  if (!response.ok) throw new Error(result.error || 'network');
  return result;
}
function report(error) {
  notify(errors[error.message] || 'Нет связи с сервисом цен. Проверьте подключение и попробуйте ещё раз.', true);
  if (error.message === 'login_required') showLogin();
}
function showLogin() { csrf = ''; loginPanel.hidden = false; editor.hidden = true; logoutButton.hidden = true; }
function updateDirty() {
  dirty = JSON.stringify(data.prices) !== savedPrices;
  const valid = [...form.querySelectorAll('input[type=number]')].every(input => input.value !== '' && input.validity.valid);
  saveButton.disabled = !dirty || !valid || saving;
  document.getElementById('changes').textContent = !valid ? 'Проверьте выделенные поля' : dirty ? 'Есть несохранённые изменения' : 'Нет несохранённых изменений';
}
function applyFilter() {
  const query = search.value.toLocaleLowerCase('ru').trim();
  let count = 0;
  document.querySelectorAll('.group').forEach(group => {
    let groupCount = 0;
    group.querySelectorAll('.service').forEach(row => {
      row.hidden = !row.dataset.search.includes(query);
      if (!row.hidden) { count++; groupCount++; }
    });
    group.hidden = !groupCount;
  });
  document.getElementById('no-results').hidden = count > 0;
}
function render() {
  const rows = document.getElementById('rows');
  rows.replaceChildren();
  let previous = '';
  let group;
  for (const service of data.services) {
    if (previous !== service.category) {
      group = document.createElement('section');
      group.className = 'group';
      const heading = document.createElement('h2');
      heading.textContent = service.category;
      group.append(heading);
      rows.append(group);
      previous = service.category;
    }
    const row = document.createElement('div');
    row.className = 'service';
    row.dataset.search = `${service.name} ${service.category} ${service.note}`.toLocaleLowerCase('ru');
    const name = document.createElement('div');
    name.className = 'service-name';
    name.textContent = service.name;
    if (service.note) { const note = document.createElement('small'); note.textContent = service.note; name.append(note); }
    row.append(name);
    for (const [city, title] of [['moscow', 'Москва'], ['makhachkala', 'Махачкала']]) {
      const wrapper = document.createElement('div');
      wrapper.className = 'city-price';
      const label = document.createElement('label');
      label.textContent = `${title}, ₽`;
      const input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.max = '1000000'; input.step = '1'; input.required = true;
      input.inputMode = 'numeric';
      input.value = data.prices[service.id][city].amount;
      input.setAttribute('aria-label', `${service.category}: ${service.name}, ${title}, цена в рублях`);
      input.addEventListener('input', () => {
        const valid = input.value !== '' && input.validity.valid;
        input.setAttribute('aria-invalid', String(!valid));
        wrapper.classList.toggle('invalid', !valid);
        data.prices[service.id][city].amount = valid ? Number(input.value) : null;
        updateDirty();
      });
      label.append(input);
      const from = document.createElement('label');
      from.className = 'from-check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = data.prices[service.id][city].from;
      checkbox.setAttribute('aria-label', `${service.category}: ${service.name}, ${title}, цена от указанной суммы`);
      checkbox.addEventListener('change', () => { data.prices[service.id][city].from = checkbox.checked; updateDirty(); });
      from.append(checkbox, document.createTextNode('Стоимость от'));
      wrapper.append(label, from);
      row.append(wrapper);
    }
    group.append(row);
  }
  document.getElementById('updated').textContent = `Сохранено ${date.format(new Date(data.updatedAt))}`;
  applyFilter();
  updateDirty();
}
async function load() {
  data = await api('/api/prices');
  savedPrices = JSON.stringify(data.prices);
  render();
}
login.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = login.querySelector('button');
  submit.disabled = true;
  try {
    const credentials = Object.fromEntries(new FormData(login));
    const session = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
    login.elements.password.value = '';
    csrf = session.csrf;
    if (!data) await load();
    loginPanel.hidden = true; editor.hidden = false; logoutButton.hidden = false;
    notify(dirty ? 'Вы вошли. Несохранённые изменения сохранены в форме.' : 'Вы вошли. Можно изменить цены.');
  } catch (error) { report(error); }
  finally { submit.disabled = false; }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!dirty || saving || !form.reportValidity()) return;
  saving = true;
  form.querySelectorAll('input').forEach(input => { input.disabled = true; });
  saveButton.disabled = true; reloadButton.disabled = true; logoutButton.disabled = true;
  saveButton.textContent = 'Сохраняем…';
  const pending = structuredClone(data.prices);
  try {
    const saved = await api('/api/prices', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ revision: data.revision, prices: pending }) });
    const check = await api('/api/prices');
    if (check.revision < saved.revision || (check.revision === saved.revision && JSON.stringify(check.prices) !== JSON.stringify(pending))) throw new Error('server_error');
    data = check;
    savedPrices = JSON.stringify(check.prices);
    render();
    notify(check.revision === saved.revision ? 'Цены сохранены и проверены. На сайте они появятся при следующем открытии страницы.' : 'Ваши цены сохранены. После этого поступили изменения из другой вкладки; в форме показаны последние цены.');
  } catch (error) { report(error); }
  finally {
    saving = false;
    form.querySelectorAll('input').forEach(input => { input.disabled = false; });
    reloadButton.disabled = false; logoutButton.disabled = false;
    saveButton.textContent = 'Сохранить цены';
    updateDirty();
  }
});
reloadButton.addEventListener('click', async () => {
  if (dirty && !confirm('Загрузить сохранённые цены? Ваши несохранённые изменения будут заменены.')) return;
  reloadButton.disabled = true;
  try { await load(); notify('Загружены последние сохранённые цены.'); } catch (error) { report(error); }
  finally { reloadButton.disabled = false; }
});
logoutButton.addEventListener('click', async () => {
  if (dirty && !confirm('Выйти и удалить несохранённые изменения из формы?')) return;
  try {
    await api('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } });
    data = null; savedPrices = ''; dirty = false;
    document.getElementById('rows').replaceChildren();
    showLogin(); notify('Вы вышли.');
  } catch (error) { report(error); }
});
search.addEventListener('input', applyFilter);
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
if (!configBase || new URL(configBase).origin === location.origin) {
  api('/api/session').then(async session => {
    csrf = session.csrf;
    await load();
    loginPanel.hidden = true; editor.hidden = false; logoutButton.hidden = false;
  }).catch(error => { if (error.message !== 'login_required') report(error); });
}
