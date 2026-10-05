import { readFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { validatePrices } from '../server/store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const seed = JSON.parse(await readFile(join(root, 'data/seed.json'), 'utf8'));
if (seed.services.length !== 35 || new Set(seed.services.map(x => x.id)).size !== 35) throw new Error('Invalid catalog');
validatePrices(seed.prices, seed.services);
for (const file of ['index.html', 'admin/index.html', 'assets/site.css', 'assets/admin.css', 'assets/portrait.jpg', 'config.js']) await access(join(root, file));
for (const folder of ['server', 'scripts', 'tests', 'assets']) {
  for (const file of await readdir(join(root, folder))) {
    if (!/\.(mjs|js)$/.test(file)) continue;
    const checked = spawnSync(process.execPath, ['--check', join(root, folder, file)], { encoding: 'utf8' });
    if (checked.status !== 0) throw new Error(`Syntax error: ${folder}/${file}`);
  }
}
const publicText = [await readFile(join(root, 'index.html'), 'utf8'), await readFile(join(root, 'admin/index.html'), 'utf8'), await readFile(join(root, 'assets/site.js'), 'utf8'), await readFile(join(root, 'assets/admin.js'), 'utf8'), JSON.stringify(seed.services)].join('\n');
const forbidden = /\b(?:оффер|дедлайн|фича|кейс|лид|вебинар|челлендж|буст|апгрейд|деплой|релиз|скилл|фреймворк|кастомный|дефолтный)\b|гарантируем результат|точно получится|100% сработает|шедевр|революционный|уникальный|инновационный|—/iu;
// Cyrillic words are checked separately because JavaScript's word boundary is ASCII-only.
const cyrillic = /(?:^|[^\p{L}])(?:оффер|дедлайн|фича|кейс|лид|вебинар|челлендж|буст|апгрейд|деплой|релиз|скилл|фреймворк|кастомный|дефолтный)(?:$|[^\p{L}])/iu;
if (forbidden.test(publicText) || cyrillic.test(publicText)) throw new Error('Forbidden public wording');
// Medical qualifications describe the doctor's existing credentials, not a training product.
if (/курс|обучени|школ|академи|урок|ученик|студент|слушател|преподавател|учитель|тьютор|домашн|экзамен|зачёт|аттестаци|сертификат/iu.test(publicText)) throw new Error('Unexpected education wording');
const page = await readFile(join(root, 'index.html'), 'utf8');
for (const [, file] of page.matchAll(/(?:src|href)="(\/(?:assets\/[^"#]+|config\.js))"/g)) await access(join(root, file));
console.log('PASS: 35 services, 70 prices, scripts, page assets and public wording.');
