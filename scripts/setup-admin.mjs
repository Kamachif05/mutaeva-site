import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

if (!stdin.isTTY) throw new Error('Use an interactive terminal to set the admin password.');
const reader = createInterface({ input: stdin, output: stdout });
const username = (await reader.question('Логин (3-80 символов, латиница, цифры, . @ _ -): ')).trim();
reader.close();
if (!/^[\w.@-]{3,80}$/.test(username)) throw new Error('Invalid username');

async function secret(prompt) {
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => { stdin.off('data', handler); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); };
    function handler(chunk) {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') { finish(); reject(new Error('Cancelled')); return; }
        if (character === '\r' || character === '\n') { finish(); resolve(value); return; }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    }
    stdin.on('data', handler);
  });
}
const password = await secret('Пароль (минимум 12 символов, ввод скрыт): ');
if (password.length < 12 || password.length > 256) throw new Error('Password must contain 12-256 characters');
if (await secret('Повторите пароль: ') !== password) throw new Error('Passwords differ');
const salt = randomBytes(16).toString('hex');
const hash = await promisify(scrypt)(password, salt, 64);
const directory = fileURLToPath(new URL('../runtime/', import.meta.url));
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(new URL('../runtime/admin.json', import.meta.url), JSON.stringify({ username, passwordHash: `${salt}:${hash.toString('hex')}` }), { flag: 'wx', mode: 0o600 });
console.log('Учётная запись создана. Пароль не сохранён; сохранён только его защищённый отпечаток.');
