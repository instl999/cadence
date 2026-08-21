/**
 * Single source of truth for stem-role recognition.
 *
 * Every consumer — the renderer library, the build script — derives its regexes
 * from this one table so the rules cannot drift apart between them.
 *
 * ORDER IS LOAD-BEARING. "no_vocals" contains "vocals", so the instrumental
 * patterns must be tested before the vocal patterns. Testing vocals first files
 * a Demucs instrumental as the vocal stem and silently drops the real vocals.
 * Add new labels to the row they belong to; do not reorder the rows.
 */
/**
 * Each row is [role, words, titleProne].
 *
 * `words` is matched inside a UVR "(...)" marker, where the text is known to be
 * a role label rather than part of a title. `titleProne` names the subset that
 * also turns up in ordinary song titles — "Piano Man", "Backing Up" — which is
 * excluded when matching a bare filename. Separator tools write canonical bare
 * names (vocals.wav, no_vocals.wav, drums.wav, bass.wav, other.wav), so the
 * narrower bare list still recognises every real output.
 */
export const ROLE_WORDS = [
  ['instrumental', ['no[\\s_.-]?vocals?', 'instrumental', 'accompaniment', 'karaoke', 'backing', '伴奏'], ['backing']],
  ['vocals', ['vocals?', 'lead[\\s_.-]?vox', 'vox', '人声'], []],
  ['drums', ['drums?', '鼓组?', '鼓'], []],
  ['bass', ['bass', '贝斯', '低音'], []],
  ['other', ['other', 'piano', 'guitar', '其他', '钢琴', '吉他'], ['piano', 'guitar', '钢琴', '吉他']],
];

export const ROLES = ROLE_WORDS.map(([role]) => role);

const alternation = (words) => words.join('|');
const bareWords = ([, words, titleProne = []]) => words.filter((w) => !titleProne.includes(w));

/** Unanchored: matched against the text inside a UVR "(...)" marker. */
const MARKER_RE = ROLE_WORDS.map((row) =>
  [new RegExp(`(?:${alternation(row[1])})`, 'i'), row[0]]);

/** Anchored: matched against a bare filename, where separators are boundaries. */
const FILE_RE = ROLE_WORDS.map((row) =>
  [new RegExp(`(?:^|[\\s_.-])(?:${alternation(bareWords(row))})(?:$|[\\s_.-])`, 'i'), row[0]]);

/** Strips a trailing role label, and everything after it, from a bare filename. */
export const ROLE_SUFFIX_RE = new RegExp(
  `(?:^|[\\s_.-]+)(?:${alternation(ROLE_WORDS.flatMap(bareWords))}).*$`,
  'i',
);

const firstMatch = (table, text) => (table.find(([pattern]) => pattern.test(text)) || [])[1] ?? null;

/** Role named inside a UVR marker, as in `Song_(Instrumental).wav`. */
export function roleFromMarker(text) {
  return firstMatch(MARKER_RE, text);
}

/** Role named by a bare filename, as in Demucs `no_vocals.wav`. */
export function roleFromFileName(bare) {
  return firstMatch(FILE_RE, bare);
}

/**
 * Loose match over a whole filename including its extension. Used by the build
 * script, where inputs are raw directory entries rather than cleaned titles.
 */
export function roleFromLooseName(name) {
  return firstMatch(MARKER_RE, name);
}
