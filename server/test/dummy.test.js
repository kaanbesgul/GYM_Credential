import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDummy } from '../src/config.js';

const SERVER = resolve(import.meta.dirname, '..');
const EXAMPLE = join(SERVER, '.env.example');

/** .env.example'ı geçici bir klasöre .env olarak kopyalayıp betiği orada çalıştırır. */
function runWithExampleEnv(script) {
  const dir = mkdtempSync(join(tmpdir(), 'gym-dummy-'));
  try {
    copyFileSync(EXAMPLE, join(dir, '.env'));
    const result = spawnSync(process.execPath, ['--no-warnings', join(SERVER, 'src', script)], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 15_000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, // ortam değişkenleri sızmasın
    });
    return { ...result, dbCreated: existsSync(join(dir, 'data')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Örnek (DUMMY) değerler gerçek sistemde çalışmaz', () => {
  it('isDummy yalnızca DUMMY ile başlayan değerleri tanır', () => {
    assert.equal(isDummy('DUMMY-KAPI-ANAHTARI'), true);
    assert.equal(isDummy('dummy-küçük-harf'), true);
    assert.equal(isDummy('gercek-rastgele-deger'), false);
    assert.equal(isDummy('xDUMMY'), false);
    assert.equal(isDummy(undefined), false);
  });

  it('.env.example gerçekten sahte olduğunu açıkça söyler ve tüm sırlar DUMMY ile başlar', () => {
    const text = readFileSync(EXAMPLE, 'utf8');
    assert.match(text, /DUMMY/);
    for (const key of ['JWT_SECRET', 'ADMIN_PASSWORD', 'GATE_KEY']) {
      const value = new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1];
      assert.ok(isDummy(value), `${key} sahte görünmüyor: ${value}`);
    }
  });

  it('kurulum betiği .env.example değerleriyle hesap ve veritabanı OLUŞTURMAZ', () => {
    const run = runWithExampleEnv('setup.js');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /DUMMY/);
    assert.equal(run.dbCreated, false);
  });

  it('sunucu sahte JWT_SECRET ile başlamayı reddeder', () => {
    const run = runWithExampleEnv('index.js');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /DUMMY/);
  });
});
