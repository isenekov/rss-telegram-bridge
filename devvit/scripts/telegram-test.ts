import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { TelegramClient, TelegramError, SMOKE_MESSAGE, deliverOnce } from '../src/telegram.ts';
import { FileJournal } from './telegram-state.ts';

const preview = SMOKE_MESSAGE.replaceAll('<b>', '').replaceAll('</b>', '');
const cleanLabel = (v: string) => v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 100);
async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--preview')) throw new TelegramError('NO_SECRET_COMMAND_LINE_ARGUMENTS');
  console.log(`Одно тестовое сообщение (без данных Reddit):\n\n${preview}\n`);
  if (process.argv.includes('--preview')) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new TelegramError('RUN_IN_INTERACTIVE_TERMINAL');
  // The TTY is controlled by readline but its echo goes to a sink. Neither
  // tokens nor chat identifiers become shell commands or readline history.
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: sink, terminal: true, historySize: 0 });
  let cancelled = false;
  input.on('SIGINT', () => { cancelled = true; input.close(); });
  const hidden = async (label: string) => {
    process.stdout.write(label);
    const answer = await input.question('');
    process.stdout.write('\n');
    if (cancelled) throw new TelegramError('CANCELLED');
    return answer.trim();
  };
  try {
    const token = await hidden('Токен существующего Telegram-бота (ввод скрыт): ');
    const chat = await hidden('ID канала (-100…) или @имя_канала (ввод скрыт): ');
    const client = new TelegramClient(token);
    const target = await client.resolveChannel(chat);
    if (cancelled) throw new TelegramError('CANCELLED');
    console.log(`Бот: @${cleanLabel(target.botUsername)}. Канал: ${cleanLabel(target.title)}.`);
    const journal = new FileJournal(fileURLToPath(new URL('../.telegram-test-state/', import.meta.url)), target);
    const result = await deliverOnce(journal, () => client.send(target, SMOKE_MESSAGE));
    console.log(JSON.stringify({ event: 'telegram_smoke', ...result }));
    if (result.kind === 'sent' || result.kind === 'already_sent') {
      console.log(result.kind === 'sent' ? 'Тест отправлен. Проверь канал.' : 'Этот тест уже отправлен; повторное сообщение не создано.');
    } else if (result.kind === 'rejected') {
      console.log('Telegram явно отклонил запрос. После исправления причины можно запустить тест снова, соблюдая паузу.');
      process.exitCode = 1;
    } else if (result.kind === 'busy' || result.kind === 'cooldown') {
      console.log('Отправка не запущена: другой процесс или пауза после отказа.');
      process.exitCode = 1;
    } else {
      console.log('Повторная отправка заблокирована. Проверь канал и сохрани эту строку результата; не удаляй журнал теста.');
      process.exitCode = 1;
    }
  } finally { input.close(); }
}
main().catch(error => {
  // Never print arbitrary error objects, stacks, URLs, tokens or API bodies.
  console.error(JSON.stringify({ event: 'telegram_smoke', kind: 'error', code: error instanceof TelegramError ? error.message : 'TEST_FAILED' }));
  process.exitCode = 1;
});
