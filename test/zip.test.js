/**
 * The archive that hands Jack his photos back.
 *
 * A subtly broken ZIP is worse than none: it downloads, sits on the desktop,
 * and fails only when opened — after the originals may be gone. So beyond the
 * structural checks here, the suite shells out to Python's zipfile, an
 * implementation this code has never met, and makes IT read the archive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildZip, crc32, safeEntryName } from '../lib/zip.js';

test('crc32 matches the published test vectors', () => {
    // The check values every CRC-32 implementation must reproduce.
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    assert.equal(crc32(Buffer.from('hello')), 0x3610a686);
    assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('an independent unzipper can read every byte back', () => {
    const files = [
        { name: 'card-1-charizard.jpg', data: Buffer.from('fake jpeg one') },
        { name: 'card-2-pikachu.jpg', data: Buffer.from('fake jpeg two, longer') },
        { name: 'source-photo-9.jpg', data: Buffer.alloc(4096, 0xab) },
    ];
    const zip = buildZip(files);

    const dir = mkdtempSync(join(tmpdir(), 'ziptest-'));
    const path = join(dir, 't.zip');
    writeFileSync(path, zip);
    try {
        // testzip() re-reads every member and verifies its CRC; any corruption
        // in headers, offsets or checksums fails here.
        const out = execFileSync('python3', ['-c', `
import zipfile, sys
z = zipfile.ZipFile(${JSON.stringify(path)})
bad = z.testzip()
assert bad is None, f"corrupt member: {bad}"
names = z.namelist()
assert names == ${JSON.stringify(files.map(f => f.name))}, names
assert z.read('card-1-charizard.jpg') == b'fake jpeg one'
assert len(z.read('source-photo-9.jpg')) == 4096
print('ok')
`], { encoding: 'utf8' });
        assert.match(out, /ok/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('two entries with one name do not overwrite each other', () => {
    const zip = buildZip([
        { name: 'pikachu.jpg', data: Buffer.from('first') },
        { name: 'pikachu.jpg', data: Buffer.from('second') },
        { name: 'pikachu.jpg', data: Buffer.from('third') },
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'ziptest-'));
    const path = join(dir, 't.zip');
    writeFileSync(path, zip);
    try {
        const out = execFileSync('python3', ['-c', `
import zipfile
z = zipfile.ZipFile(${JSON.stringify(path)})
assert z.namelist() == ['pikachu.jpg', 'pikachu-2.jpg', 'pikachu-3.jpg'], z.namelist()
assert z.read('pikachu-3.jpg') == b'third'
print('ok')
`], { encoding: 'utf8' });
        assert.match(out, /ok/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('an empty archive is still a valid archive', () => {
    const zip = buildZip([]);
    assert.equal(zip.length, 22, 'just the end-of-central-directory record');
    assert.equal(zip.readUInt32LE(0), 0x06054b50);
});

/**
 * Entry names come from card names, which can be in any script Pokémon prints
 * in. The archive must open on the least forgiving unzipper, so names fold to
 * portable ASCII — the card's own identity lives in the id prefix regardless.
 */
test('names in any script become portable entry names', () => {
    assert.equal(safeEntryName('Pokémon'), 'Pokemon');
    assert.equal(safeEntryName('Mega Zygarde ex 120/088'), 'Mega-Zygarde-ex-120-088');
    assert.equal(safeEntryName('リザードン'), 'file', 'nothing survives, so the fallback stands in');
    assert.equal(safeEntryName('リザードン', 'card-42'), 'card-42');
    assert.equal(safeEntryName('...'), 'file', 'dots alone cannot escape a directory');
    assert.equal(safeEntryName('../../etc/passwd'), 'etc-passwd', 'path traversal is folded away');
});
