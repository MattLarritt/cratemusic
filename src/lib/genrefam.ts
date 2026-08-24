/**
 * The genre taxonomy: every tag the library actually carries, folded into musicmap-style
 * SUPER-GENRE families with an adjacency graph between neighbours.
 *
 * The single home for the taxonomy: the DJ (lib/dj.ts) and dynamic playlists both import
 * it from here, so they can never disagree about what "metal" means. (It briefly had a
 * second home as a bundled copy inside the intelligent-shuffle plugin; that ended when the
 * DJ went native.)
 *
 * Why this exists: exact genre strings are too sparse to steer with. Families are the
 * musicmap insight applied: genres are fluid concentrations inside well-known larger
 * areas, and kinship inside an area (plus a weaker pull from adjacent areas) is exactly
 * what "music like this" means — for the DJ's votes and for dynamic playlist rules alike.
 *
 * Classification is ordered pattern matching, hybrids first — "industrial metal" must
 * hit metal before industrial, "emo rap" must hit rap before punk, "pop punk" punk
 * before pop. Order IS the disambiguation; add new rules with care.
 */

export type Family =
  | 'metal'
  | 'industrial'
  | 'punk'
  | 'alt'
  | 'rock'
  | 'folk'
  | 'blues'
  | 'rnb'
  | 'rap'
  | 'pop'
  | 'electronic'
  | 'downtempo'
  | 'reggae'
  | 'world'
  | 'classical';

export const FAMILY_LABEL: Record<Family, string> = {
  metal: 'metal',
  industrial: 'industrial',
  punk: 'punk & hardcore',
  alt: 'alt & indie',
  rock: 'rock',
  folk: 'folk & country',
  blues: 'blues & jazz',
  rnb: 'r&b & soul',
  rap: 'hip-hop',
  pop: 'pop',
  electronic: 'electronic',
  downtempo: 'downtempo',
  reggae: 'reggae',
  world: 'world',
  classical: 'classical',
};

/*
 * Musicmap's horizontal neighbourhoods, pruned to this library's reality. Symmetrized
 * below — list each edge once. Adjacent families feel a vote at reduced strength: a
 * metal mood leans industrial and punk a little, never country.
 */
const EDGES: [Family, Family][] = [
  ['metal', 'industrial'],
  ['metal', 'punk'],
  ['metal', 'alt'],
  ['punk', 'alt'],
  ['alt', 'rock'],
  ['alt', 'pop'],
  ['rock', 'blues'],
  ['rock', 'folk'],
  ['folk', 'blues'],
  ['blues', 'rnb'],
  ['rnb', 'pop'],
  ['rnb', 'rap'],
  ['rap', 'electronic'],
  ['rap', 'reggae'],
  ['rnb', 'reggae'],
  ['pop', 'electronic'],
  ['electronic', 'industrial'],
  ['electronic', 'downtempo'],
  ['downtempo', 'rnb'],
  ['world', 'pop'],
  ['classical', 'downtempo'],
];

export const ADJACENT: Record<Family, Family[]> = (() => {
  const out = Object.fromEntries(
    (Object.keys(FAMILY_LABEL) as Family[]).map((f) => [f, [] as Family[]]),
  ) as Record<Family, Family[]>;
  for (const [a, b] of EDGES) {
    out[a].push(b);
    out[b].push(a);
  }
  return out;
})();

/*
 * Tags that describe the LISTENER or the FILING, not the music. Last.fm artist tags are
 * full of these; matching them to a family would let "seen live" steer the queue.
 */
// Fully anchored — an unanchored "uk" once swallowed "uk garage" whole.
const JUNK =
  /^(?:seen live|american|british|english|irish|scottish|german|french|australian|canadian|usa|uk|america|états unidos|estados unidos|américain|france|\d{2,4}s?|(?:fe)?male vocals?(?:ists?)?|vocalist|guitarist|guitar|piano|actor|fictional|political|queer|compilation|special purpose artist|grammy winner|favou?rites?|awesome|good|songwriter|producer|instrumental)$/;

/** Ordered: first match wins. Hybrids resolve by whichever family owns the word that
 * matters — the ordering below encodes those calls. */
const RULES: [RegExp, Family][] = [
  [/metal|thrash|doom|rapcore|neue deutsche|^heavy$/, 'metal'],
  [/industrial|^noise/, 'industrial'],
  [/trip.?hop|downtempo|ambient|chillout|new age|lo-fi|lofi/, 'downtempo'],
  [/hip.?hop|\brap\b|\btrap\b|boom bap|dirty south|gangsta|drill|grime/, 'rap'],
  [/punk|hardcore|easycore|\bemo\b|emocore|screamo/, 'punk'],
  [/reggae|dancehall|\bska\b|dub\b/, 'reggae'],
  [/indian|bollywood|latin|afrobeat|k-pop|j-pop|world/, 'world'],
  [/country|folk|americana|bluegrass|singer.?.?songwriter|red dirt|nashville|heartland|acoustic/, 'folk'],
  [
    /grunge|indie|alternative|\balt\b|alt\.|alternrock|shoegaze|dream pop|madchester|new wave|britpop|jangle|bedroom pop|art rock|art pop|experimental|post-rock|hypnagogic|slowcore|noise rock/,
    'alt',
  ],
  [
    /rock|rockabilly|stoner|surf|psychedeli|krautrock|palm desert|desert|jam band|progressive|heavy psych/,
    'rock',
  ],
  [/r&b|r b|rnb|\bsoul\b|funk|disco|motown|neo.?soul/, 'rnb'],
  [/pop|ballad|yacht/, 'pop'],
  [
    /electro|techno|house|trance|\bedm\b|eurodance|eurobeat|drum & bass|drum and bass|drum 'n' bass|dubstep|jungle|breakbeat|\bdance\b|rave|leftfield|tronica|garage$|uk garage|idm|synthwave/,
    'electronic',
  ],
  [/blues|jazz|swing|bebop/, 'blues'],
  [/classical|score|soundtrack|orchestral|baroque|opera/, 'classical'],
];

/** True for tags that describe the listener or the filing, not the music. */
export function isJunk(genre: string): boolean {
  return JUNK.test(genre.trim().toLowerCase());
}

/** One genre string → its family, or null for junk and the unclassifiable. */
export function familyOf(genre: string): Family | null {
  const g = genre.trim().toLowerCase();
  if (!g || JUNK.test(g)) return null;
  for (const [pattern, family] of RULES) {
    if (pattern.test(g)) return family;
  }
  return null;
}

/** The distinct families behind a track's genre list, in first-seen order. */
export function familiesOf(genres: string[]): Family[] {
  const seen = new Set<Family>();
  const out: Family[] = [];
  for (const g of genres) {
    const f = familyOf(g);
    if (f && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}
