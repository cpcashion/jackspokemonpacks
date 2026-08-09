/**
 * A minimal ZIP writer, so the photos Jack uploaded can be handed back.
 *
 * The scan photos live inside Postgres as base64 data URLs — there is no
 * folder anywhere to point a download at, on Render or on Neon. Getting them
 * out means building an archive on the fly.
 *
 * Store-only (method 0), deliberately: every entry is a JPEG, which is already
 * compressed, so DEFLATE would spend CPU to save close to nothing. Store-only
 * also keeps this file dependency-free and small enough to be obviously
 * correct: local headers, a central directory, an end record, and a CRC.
 *
 * No ZIP64. That caps the format at 4GB and 65,535 entries; the entire
 * collection's photos are two orders of magnitude under both.
 */

/** CRC-32, the one non-trivial thing the format requires. */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, the only timestamp format classic ZIP has. */
function dosDateTime(date) {
    const d = date instanceof Date && !isNaN(date) ? date : new Date();
    const year = Math.max(1980, d.getFullYear());
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
}

/**
 * Entry names arrive from card names, which can be anything Pokémon prints in
 * any script. Fold them to something every unzipper accepts.
 */
export function safeEntryName(name, fallback = 'file') {
    const cleaned = String(name || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\w.-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, 120);
    return cleaned || fallback;
}

/**
 * Build a complete ZIP archive in memory.
 *
 * @param {Array<{name: string, data: Buffer, mtime?: Date}>} files
 * @returns {Buffer}
 */
export function buildZip(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const seen = new Set();

    for (const file of files || []) {
        const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || '');
        // Two cards named identically must not silently overwrite each other
        // inside the archive.
        let name = file.name;
        for (let n = 2; seen.has(name); n++) {
            const dot = file.name.lastIndexOf('.');
            name = dot > 0 ? `${file.name.slice(0, dot)}-${n}${file.name.slice(dot)}` : `${file.name}-${n}`;
        }
        seen.add(name);

        const nameBytes = Buffer.from(name, 'utf8');
        const crc = crc32(data);
        const { time, date } = dosDateTime(file.mtime);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);   // local file header signature
        local.writeUInt16LE(20, 4);           // version needed
        local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 names
        local.writeUInt16LE(0, 8);            // method: store
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18); // compressed = uncompressed (store)
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);           // extra length

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); // central directory signature
        central.writeUInt16LE(20, 4);         // version made by
        central.writeUInt16LE(20, 6);         // version needed
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        // extra, comment, disk, internal attrs, external attrs: all zero
        central.writeUInt32LE(offset, 42);    // offset of local header

        localParts.push(local, nameBytes, data);
        centralParts.push(central, nameBytes);
        offset += local.length + nameBytes.length + data.length;
    }

    const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
    const count = seen.size;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);         // end of central directory
    end.writeUInt16LE(count, 8);
    end.writeUInt16LE(count, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);            // central directory starts after data

    return Buffer.concat([...localParts, ...centralParts, end]);
}
