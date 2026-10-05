const base = (window.MUTAEVA_CONFIG?.apiBase || '').replace(/\/$/, '');
const catalog = document.getElementById('price-catalog');
const status = document.getElementById('price-status');
const search = document.getElementById('service-search');
const retry = document.getElementById('retry-prices');
let currentCity = 'makhachkala';
let snapshot = null;
const money = new Intl.NumberFormat('ru-RU');

if (base) document.getElementById('admin-link').href = `${base}/admin/`;

function render() {
  catalog.replaceChildren();
  const query = search.value.trim().toLocaleLowerCase('ru');
  let count = 0;
  let previous = '';
  let group;
  for (const service of snapshot?.services || []) {
    if (!`${service.name} ${service.category} ${service.note}`.toLocaleLowerCase('ru').includes(query)) continue;
    if (previous !== service.category) {
      group = document.createElement('section');
      group.className = 'price-group';
      const heading = document.createElement('h3');
      heading.className = 'price-category';
      heading.textContent = service.category;
      group.append(heading);
      catalog.append(group);
      previous = service.category;
    }
    const row = document.createElement('div');
    row.className = 'price-row';
    row.dataset.service = service.id;
    const name = document.createElement('div');
    name.className = 'price-name';
    name.textContent = service.name;
    if (service.note) {
      const note = document.createElement('small');
      note.textContent = service.note;
      name.append(note);
    }
    const value = document.createElement('div');
    value.className = 'price-value';
    const price = snapshot.prices[service.id][currentCity];
    value.textContent = `${price.from ? 'от ' : ''}${money.format(price.amount)} ₽`;
    row.append(name, value);
    group.append(row);
    count++;
  }
  document.getElementById('empty-search').hidden = !snapshot || count > 0;
}

async function loadPrices() {
  retry.hidden = true;
  catalog.setAttribute('aria-busy', 'true');
  status.textContent = 'Загружаем стоимость услуг…';
  try {
    const response = await fetch(`${base}/api/prices`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('unavailable');
    const data = await response.json();
    if (!Array.isArray(data.services) || data.services.length !== 35 || !data.prices || !Number.isFinite(Date.parse(data.updatedAt))) throw new Error('invalid');
    for (const { id, category, name, note } of data.services) {
      if (![id, category, name, note].every(x => typeof x === 'string')) throw new Error('invalid');
      for (const city of ['moscow', 'makhachkala']) {
        const value = data.prices[id]?.[city];
        if (!value || !Number.isInteger(value.amount) || value.amount < 0 || value.amount > 1000000 || typeof value.from !== 'boolean') throw new Error('invalid');
      }
    }
    snapshot = data;
    render();
    status.textContent = `Цены обновлены ${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow' }).format(new Date(data.updatedAt))}. Перед процедурой проводится консультация.`;
  } catch {
    snapshot = null;
    render();
    status.textContent = 'Не удалось загрузить текущие цены. Уточните стоимость при записи или попробуйте ещё раз.';
    retry.hidden = false;
  } finally { catalog.setAttribute('aria-busy', 'false'); }
}

document.querySelectorAll('.city-btn').forEach(button => button.addEventListener('click', () => {
  currentCity = button.dataset.city;
  document.querySelectorAll('.city-btn').forEach(item => {
    const active = item === button;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  render();
}));
search.addEventListener('input', render);
retry.addEventListener('click', loadPrices);
loadPrices();
