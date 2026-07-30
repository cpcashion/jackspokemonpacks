/**
 * Multi-language card identity.
 *
 * Pokémon prints in fifteen languages. normalizeText used to strip everything
 * outside [a-z0-9], which reduced every Japanese, Chinese, Korean and Russian
 * card name to the empty string. Two things followed, and both are pinned here:
 *
 *  1. A name that normalises to nothing was reported as unreadable, so scanning
 *     any non-Latin card produced "Could not read the card name" — even when
 *     the AI had read it perfectly.
 *  2. Worse and quieter: every such card produced an identical variant key, so
 *     two unrelated Japanese cards looked like two copies of one printing and
 *     would have been folded together.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeText,
    normalizeLanguage,
    normalizeCardNumber,
    languageCode,
    languageLabel,
    languageIsCertain,
    isNonEnglish,
    hasNonLatinScript,
    buildVariantKey,
    LANGUAGES,
} from '../lib/identity.js';

test('names in every script survive normalisation', () => {
    const cases = [
        ['古空棘鱼', 'Chinese (Simplified)'],
        ['リザードン', 'Japanese katakana'],
        ['ピカチュウ', 'Japanese with a small kana'],
        ['리자몽', 'Korean'],
        ['Флареон', 'Russian'],
        ['ลิซาร์ดอน', 'Thai'],
    ];
    for (const [name, why] of cases) {
        assert.notEqual(normalizeText(name), '', `${why} must not normalise to nothing`);
    }
});

test('Latin accents still fold, so Pokémon and Pokemon are one name', () => {
    assert.equal(normalizeText('Pokémon'), 'pokemon');
    assert.equal(normalizeText('Flabébé'), 'flabebe');
    assert.equal(normalizeText('Nidoran♀'), 'nidoran');
    assert.equal(normalizeText("Farfetch'd"), 'farfetch d');
});

/**
 * The subtle one. NFKD decomposes が into か plus a combining dakuten at U+3099,
 * which is outside the U+0300–U+036F range the accent strip removes — so
 * without a recomposing pass afterwards, one string would carry the mark and
 * the other would not, and two spellings of the same name would never match.
 */
test('kana keep their dakuten, however the input was composed', () => {
    const composed = 'ガブリアス';
    assert.equal(normalizeText(composed), normalizeText(composed.normalize('NFD')));
    assert.equal(normalizeText(composed), normalizeText(composed.normalize('NFC')));
    // And the mark is genuinely still there: ガ must not collapse to カ.
    assert.notEqual(normalizeText('ガ'), normalizeText('カ'));
});

test('two different non-Latin cards get two different identities', () => {
    const relicanth = buildVariantKey({
        card_name: '古空棘鱼', card_number: '014/131', language: 'Chinese (Simplified)',
    });
    const charizard = buildVariantKey({
        card_name: 'リザードン', card_number: '004/102', language: 'Japanese',
    });
    assert.notEqual(relicanth, charizard);
    // Neither may have an empty name segment, which is what made them collide.
    for (const key of [relicanth, charizard]) {
        assert.notEqual(key.split('|')[0], '', `"${key}" has no name to identify it by`);
    }
});

test('the same Pokémon in two languages is two different cards', () => {
    const base = { card_name: 'Charizard', card_set: 'Base Set', card_number: '4/102', holo_type: 'Holofoil' };
    const keys = [
        buildVariantKey({ ...base, language: 'English' }),
        buildVariantKey({ ...base, language: 'Japanese' }),
        buildVariantKey({ ...base, language: 'Chinese (Simplified)' }),
        buildVariantKey({ ...base, language: 'Chinese (Traditional)' }),
    ];
    assert.equal(new Set(keys).size, 4, 'each language is its own printing');
});

test('language names are recognised however they are written', () => {
    const cases = {
        Japanese: 'japanese', JP: 'japanese', jpn: 'japanese', '日本語': 'japanese',
        'Japanese (Japan)': 'japanese',
        Korean: 'korean', ko: 'korean', '한국어': 'korean',
        'Chinese (Simplified)': 'chinese-simplified', 'simplified chinese': 'chinese-simplified',
        'zh-CN': 'chinese-simplified', '中文': 'chinese-simplified', Chinese: 'chinese-simplified',
        'Chinese (Traditional)': 'chinese-traditional', 'zh-TW': 'chinese-traditional',
        'traditional chinese': 'chinese-traditional',
        'español': 'spanish', French: 'french', Deutsch: 'german', italiano: 'italian',
        English: 'english', en: 'english',
    };
    for (const [input, expected] of Object.entries(cases)) {
        assert.equal(normalizeLanguage(input), expected, `"${input}"`);
    }
});

test('every language resolves to a code the card databases accept', () => {
    for (const [key, { code, label }] of Object.entries(LANGUAGES)) {
        assert.equal(languageCode(key), code);
        assert.equal(languageLabel(key), label);
        assert.match(code, /^[a-z]{2}(-[a-z]{2})?$/, `${key} has an odd code: ${code}`);
    }
});

/**
 * Falling back to English is right — most of the collection is English — but it
 * must be distinguishable from having actually read the language off the card,
 * because pricing decisions hang on it.
 */
test('a defaulted language is not mistaken for a known one', () => {
    assert.equal(normalizeLanguage(''), 'english');
    assert.equal(languageIsCertain(''), false);
    assert.equal(languageIsCertain('Klingon'), false);
    assert.equal(languageIsCertain('Japanese'), true);
    assert.equal(languageIsCertain('en'), true);
});

test('non-English is detected for every language but English', () => {
    assert.equal(isNonEnglish('English'), false);
    assert.equal(isNonEnglish(''), false, 'an unknown language defaults to English');
    for (const key of Object.keys(LANGUAGES)) {
        if (key === 'english') continue;
        assert.equal(isNonEnglish(key), true, key);
    }
});

test('non-Latin script is detected, and Latin names are not false positives', () => {
    assert.equal(hasNonLatinScript('リザードン'), true);
    assert.equal(hasNonLatinScript('古空棘鱼'), true);
    assert.equal(hasNonLatinScript('리자몽'), true);
    assert.equal(hasNonLatinScript('Флареон'), true);
    assert.equal(hasNonLatinScript('Charizard'), false);
    assert.equal(hasNonLatinScript('Pokémon'), false, 'an accent is still Latin');
    assert.equal(hasNonLatinScript("Farfetch'd VMAX 4/102"), false, 'punctuation and digits are not a script');
    assert.equal(hasNonLatinScript(''), false);
});

/**
 * Japanese and Chinese cards print full-width numerals. NFKD is what makes
 * those comparable to the half-width forms every API returns.
 */
test('card numbers normalise across full-width and zero-padded forms', () => {
    assert.equal(normalizeCardNumber('０１４/１３１'), normalizeCardNumber('014/131'));
    assert.equal(normalizeCardNumber('014/131'), '14');
    assert.equal(normalizeCardNumber('004/102'), '4');
    assert.equal(normalizeCardNumber('SWSH045'), 'SWSH45');
    assert.equal(normalizeCardNumber('TG12/TG30'), 'TG12');
});

/**
 * The placeholder guard has to work in every language too, or "ポケモン" would
 * be accepted as a card name.
 */
test('placeholder names are rejected in any language', () => {
    // hasMeaningfulCardName lives in server.js, so this asserts the property it
    // relies on: placeholders normalise to a stable, comparable form.
    assert.equal(normalizeText('ポケモン'), 'ポケモン');
    assert.equal(normalizeText('宝可梦'), '宝可梦');
    assert.equal(normalizeText('  Unknown  '), 'unknown');
});
