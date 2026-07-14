import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_PASSWORD = '123456';
export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 128;

function passwordError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function validatePassword(password) {
  if (typeof password !== 'string') {
    throw passwordError('password must be a string');
  }
  if (password.includes('\r') || password.includes('\n') || password.includes('\0')) {
    throw passwordError('password must not contain CR, LF, or NUL');
  }
  const length = Array.from(password).length;
  if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
    throw passwordError(`password must contain ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`);
  }
  return password;
}

function passwordMatches(left, right) {
  const leftDigest = crypto.createHash('sha256').update(left).digest();
  const rightDigest = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

export class PasswordStore {
  #filePath;
  #operations = Promise.resolve();

  constructor(filePath) {
    if (!filePath) throw new Error('password file path is required');
    this.#filePath = filePath;
  }

  get filePath() {
    return this.#filePath;
  }

  async initialize() {
    return this.#exclusive(() => this.#loadOrCreate());
  }

  async verify(candidate) {
    validatePassword(candidate);
    return this.#exclusive(async () => passwordMatches(await this.#loadOrCreate(), candidate));
  }

  async replace(currentPassword, newPassword) {
    validatePassword(currentPassword);
    validatePassword(newPassword);
    return this.#exclusive(async () => {
      const current = await this.#loadOrCreate();
      if (!passwordMatches(current, currentPassword)) {
        throw passwordError('current password is invalid', 401);
      }
      await this.#writeAtomic(newPassword);
    });
  }

  async #loadOrCreate() {
    await this.#ensureDirectory();
    try {
      return await this.#readExisting();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await this.#writeAtomic(DEFAULT_PASSWORD, { createOnly: true });
      return DEFAULT_PASSWORD;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return this.#readExisting();
    }
  }

  #exclusive(operation) {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(() => undefined, () => undefined);
    return result;
  }

  async #ensureDirectory() {
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  async #readExisting() {
    const metadata = await lstat(this.#filePath);
    if (!metadata.isFile()) throw new Error('password path must be a regular file');
    await chmod(this.#filePath, 0o600);
    const raw = await readFile(this.#filePath, 'utf8');
    const password = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    validatePassword(password);
    return password;
  }

  async #writeAtomic(password, { createOnly = false } = {}) {
    validatePassword(password);
    await this.#ensureDirectory();
    const directory = path.dirname(this.#filePath);
    const temporary = path.join(
      directory,
      `.${path.basename(this.#filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${password}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, 0o600);
      if (createOnly) {
        await copyFile(temporary, this.#filePath, constants.COPYFILE_EXCL);
        await unlink(temporary);
      } else {
        await rename(temporary, this.#filePath);
      }
      await chmod(this.#filePath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}
