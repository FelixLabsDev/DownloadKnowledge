/**
 * Prints the argon2id hash of a password, for DK_PASSWORD_HASH.
 * The password is read from stdin so it stays out of shell history:
 *   pnpm --filter @dk/server hash-password
 */
import readline from 'node:readline/promises';
import { hashPassword } from './auth';

const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
const password = (await rl.question(process.stdin.isTTY ? 'Password: ' : '')).trim();
rl.close();
if (password.length < 8) {
  console.error('Use at least 8 characters.');
  process.exit(1);
}
console.log(hashPassword(password));
