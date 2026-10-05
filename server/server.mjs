import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 3000);
const insecure = process.env.LOCAL_DEVELOPMENT === 'true';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
if (insecure && process.env.NODE_ENV === 'production') throw new Error('Insecure production forbidden');
let credentials;
if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD_HASH) {
  credentials = { username: process.env.ADMIN_USERNAME, passwordHash: process.env.ADMIN_PASSWORD_HASH };
} else {
  const file = process.env.ADMIN_CREDENTIALS_FILE || (process.env.CREDENTIALS_DIRECTORY ? `${process.env.CREDENTIALS_DIRECTORY}/admin.json` : 'runtime/admin.json');
  credentials = JSON.parse(await readFile(resolve(root, file), 'utf8'));
}
const app = await createApp({
  root,
  directory: resolve(root, process.env.DATA_DIRECTORY || 'runtime'),
  ...credentials,
  adminOrigin: process.env.ADMIN_ORIGIN || (insecure ? `http://127.0.0.1:${port}` : ''),
  publicOrigin: process.env.PUBLIC_ORIGIN || 'https://mutaeva.ru',
  insecure
});
app.requestTimeout = 15000;
app.headersTimeout = 10000;
app.listen(port, '127.0.0.1', () => console.log(`Mutaeva service listening on port ${port}`));
