/**
 * Pokémon TCG energy types.
 *
 * The trading card game has its own eleven types, which are not the same as the
 * video games' eighteen: the TCG folds Bug, Grass and Poison into Grass, Ice
 * into Water, Ground and Rock into Fighting, Ghost and Poison into Psychic, and
 * calls Electric "Lightning", Dark "Darkness" and Steel "Metal". A card printed
 * as a Psychic Pokémon is a Psychic card here whatever the Pokédex says, because
 * the type on the card is what the card is.
 *
 * Colours are the ones the game prints on the energy symbols, so a grouping by
 * type reads the way the cards themselves do rather than as an arbitrary
 * palette. They are fixed rather than theme-derived for the same reason a
 * Charizard is red in both light and dark mode.
 */

export const TYPES = {
    Grass:     { color: '#63A83B', label: 'Grass' },
    Fire:      { color: '#E2553D', label: 'Fire' },
    Water:     { color: '#33A0DA', label: 'Water' },
    Lightning: { color: '#E8B71E', label: 'Lightning' },
    Psychic:   { color: '#9B5FA6', label: 'Psychic' },
    Fighting:  { color: '#BE5F32', label: 'Fighting' },
    Darkness:  { color: '#46506A', label: 'Darkness' },
    Metal:     { color: '#7E8C9B', label: 'Metal' },
    Fairy:     { color: '#DE6F9D', label: 'Fairy' },
    Dragon:    { color: '#B99138', label: 'Dragon' },
    Colorless: { color: '#A9B0BC', label: 'Colorless' },
};

/** Cards that have no energy type at all, kept as their own buckets. */
export const NON_POKEMON = {
    Trainer: { color: '#5D7CA6', label: 'Trainer' },
    Energy:  { color: '#8A8F98', label: 'Energy' },
};

export const ALL_GROUPS = { ...TYPES, ...NON_POKEMON };

/** What the various sources and the video games call each TCG type. */
const ALIASES = new Map(Object.entries({
    electric: 'Lightning', lightning: 'Lightning',
    dark: 'Darkness', darkness: 'Darkness',
    steel: 'Metal', metal: 'Metal',
    normal: 'Colorless', colourless: 'Colorless', colorless: 'Colorless',
    // TCG collapses several video-game types into one printed type.
    bug: 'Grass', poison: 'Psychic', grass: 'Grass',
    ice: 'Water', water: 'Water',
    ground: 'Fighting', rock: 'Fighting', fighting: 'Fighting',
    ghost: 'Psychic', psychic: 'Psychic',
    flying: 'Colorless',
    fire: 'Fire', fairy: 'Fairy', dragon: 'Dragon',
    trainer: 'Trainer', energy: 'Energy',
}));

/**
 * @returns {string|null} a key of ALL_GROUPS, or null if unrecognised —
 *   never a guess, because a card filed under the wrong type is worse than a
 *   card filed under none.
 */
export function normalizeType(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (ALL_GROUPS[raw]) return raw;
    const key = raw.toLowerCase().replace(/[^a-z]/g, '');
    return ALIASES.get(key) || null;
}

/** The colour to draw a type in. */
export function typeColor(type) {
    return ALL_GROUPS[normalizeType(type) || '']?.color || ALL_GROUPS.Colorless.color;
}

/**
 * Read the types off whatever a card database returned.
 *
 * Trainer and Energy cards carry no `types` array, so their supertype becomes
 * the group — otherwise every Professor's Research would vanish from a view
 * that is supposed to account for the whole collection.
 *
 * @param {{types?: string[], supertype?: string, category?: string}} card
 * @returns {string[]} canonical group names, deduplicated, order preserved
 */
export function typesFromCard(card) {
    const raw = Array.isArray(card?.types) ? card.types : [];
    const found = raw.map(normalizeType).filter(Boolean);
    if (found.length) return [...new Set(found)];

    // Pokémon TCG API says `supertype`; TCGdex says `category`.
    const kind = normalizeType(card?.supertype || card?.category);
    return kind && NON_POKEMON[kind] ? [kind] : [];
}

/** Round-trip through the single TEXT column the types are stored in. */
export function serializeTypes(types) {
    return (types || []).map(normalizeType).filter(Boolean).join(',');
}

export function parseTypes(stored) {
    return String(stored || '').split(',').map(t => normalizeType(t.trim())).filter(Boolean);
}

/**
 * Group a collection by type for display.
 *
 * A dual-type card is counted under *both* its types, which means the type
 * counts deliberately sum to more than the number of cards. The alternative —
 * picking one type per card — would tell you Jack owns fewer Fire cards than he
 * does. `totalCards` is reported alongside so the two numbers are never
 * confused for each other.
 *
 * @param {{types?: string, quantity?: number, total_value?: number}[]} cards
 */
export function groupByType(cards) {
    const groups = new Map();
    let untyped = 0;

    for (const card of cards || []) {
        const types = parseTypes(card.types);
        if (!types.length) { untyped++; continue; }

        for (const type of types) {
            if (!groups.has(type)) {
                groups.set(type, {
                    type,
                    label: ALL_GROUPS[type].label,
                    color: ALL_GROUPS[type].color,
                    cards: [],
                    copies: 0,
                    value: 0,
                });
            }
            const g = groups.get(type);
            g.cards.push(card);
            g.copies += Number(card.quantity) || 1;
            g.value += Number(card.total_value) || 0;
        }
    }

    const list = [...groups.values()]
        .map(g => ({ ...g, value: Number(g.value.toFixed(2)), unique: g.cards.length }))
        .sort((a, b) => b.copies - a.copies || b.value - a.value);

    return {
        groups: list,
        untyped,
        totalCards: (cards || []).length,
        // Sums to more than totalCards when dual-type cards are held; named so
        // that is obvious rather than looking like an arithmetic error.
        totalTypeMemberships: list.reduce((n, g) => n + g.unique, 0),
    };
}
