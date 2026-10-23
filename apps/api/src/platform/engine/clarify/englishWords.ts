/**
 * English words the keyword corrector never touches. A typed token that is
 * itself an English word is a word the person meant, not a slip: "deposit 100
 * USDC into aave on case" must not become Base, "via delay" must not become
 * Relay, "ora" must not become Orca. Such a clause is not read (refused), never
 * corrected into a keyword.
 *
 * The list holds every common English word (SCOWL sizes 10 to 60, American,
 * British, Canadian and Australian spellings) that lies within the
 * corrector's edit thresholds (clarify/fuzzy.ts) of one of the keywords in
 * REVIEWED_KEYWORDS, plus reviewed extras ("ora", "ave"). Words farther from
 * every keyword are never corrected anyway. When the keyword vocabulary
 * changes (a new venue word), the drift test in readerHotfix.test.ts fails:
 * add the English words within one edit of the new keyword here (two edits
 * for keywords of seven letters or more) and update REVIEWED_KEYWORDS.
 *
 * Word selection uses SCOWL (wordlist.aspell.net):
 *   Copyright 2000-2016 by Kevin Atkinson
 *   Permission to use, copy, modify, distribute and sell these word lists,
 *   the associated scripts, the output created from the scripts, and its
 *   documentation for any purpose is hereby granted without fee, provided
 *   that the above copyright notice appears in all copies and that both that
 *   copyright notice and this permission notice appear in supporting
 *   documentation. Kevin Atkinson makes no representations about the
 *   suitability of this array for any purpose. It is provided "as is"
 *   without express or implied warranty.
 */

/** The keyword vocabulary this list was reviewed against (the corrector's verbs, connectors, networks and venue words). */
export const REVIEWED_KEYWORDS: readonly string[] = Object.freeze([
  // verbs (position 0)
  "swap", "convert", "trade", "exchange", "sell", "buy", "bridge", "move", "send", "transfer", "pay", "port",
  "stake", "deposit", "supply", "lend", "withdraw", "redeem",
  // connectors
  "from", "into", "onto", "with", "using", "through", "then",
  // networks
  "base", "arbitrum", "ethereum", "optimism", "polygon", "solana", "devnet", "sepolia", "mainnet",
  // venues and providers
  "aave", "compound", "comet", "morpho", "moonwell", "jupiter", "kamino", "sparklend", "spark", "fluid",
  "yearn", "lifi", "debridge", "relay", "across", "cctp", "raydium", "orca", "meteora", "uniswap", "aerodrome",
  "velodrome", "jito", "jitosol", "marinade", "msol", "jupsol", "sanctum", "lido", "steth", "wsteth", "rocket",
  "rocketpool", "reth", "ether", "etherfi", "weeth", "eeth", "stader", "ethx", "mantle", "meth", "frax",
  "sfrxeth", "frxeth", "pancakeswap", "pancake", "camelot", "curve", "finance", "native", "stake", "staking",
  "validator",
  // restaking venue words
  "kelp", "rseth", "renzo", "ezeth",
  // lending and savings words (Save, Sky, Ethena) and the Solana stake pools
  "solend", "sdai", "susds", "ethena", "susde", "blazestake", "solblaze", "bsol", "hsol", "dsol", "bonksol",
]);

/** Lower-case English words that are never corrected into a keyword. */
export const ENGLISH_WORDS: ReadonlySet<string> = new Set([
  "abase", "abridge", "abridged", "abridges", "abusing", "accosts", "actress", "aerodromes", "agave", "airdrome",
  "amino", "amusing", "ave", "awaking", "babe", "bade", "bake", "bale", "bane", "bare", "based", "baser",
  "bases", "bash", "bask", "bass", "bast", "baste", "bate", "belay", "bell", "bend", "betaking", "blend",
  "borough", "bracket", "braking", "bride", "bridged", "bridges", "bridle", "bridled", "bridles", "brindle",
  "bringer", "buoy", "bury", "bushing", "busing", "busking", "bussing", "busting", "busy", "busying", "buys",
  "captive", "carve", "case", "causing", "cave", "cell", "come", "comer", "comes", "comets", "comment", "compete",
  "composed", "compounded", "compounds", "conceit", "concept", "concern", "concert", "concerto", "concerts",
  "confers", "confound", "congers", "congest", "conkers", "connect", "consent", "consort", "content", "contest",
  "context", "contort", "convene", "convent", "convents", "converge", "converse", "converted", "converter",
  "converts", "conveys", "convict", "cove", "covert", "coverts", "covet", "cricket", "crochet", "crocked",
  "cross", "culvert", "cure", "curie", "curse", "cursing", "cursive", "curved", "curves", "curvier", "curvy",
  "cussing", "dative", "datives", "delay", "dell", "deposed", "deposes", "deposing", "deposited", "depositor",
  "deposits", "dido", "docket", "dockets", "dousing", "dove", "dusting", "ease", "eave", "either", "ell",
  "end", "etcher", "etchers", "ethereal", "exchanged", "exchanges", "fave", "fax", "feather", "fell", "fend",
  "fetcher", "finagle", "financed", "finances", "financier", "flaking", "flax", "fluidly", "fluids", "form",
  "fort", "frat", "fray", "fridge", "fridges", "fro", "frog", "fusing", "fussing", "gantlet", "gave", "grade",
  "gushing", "gusting", "hairnet", "have", "heather", "hell", "hen", "housing", "hove", "hushing", "husking",
  "impound", "inactive", "info", "jato", "jell", "jumpier", "juniper", "kith", "lacrosse", "land", "lave",
  "lead", "leaking", "learn", "leather", "led", "lends", "lens", "lent", "lewd", "lid", "lidos", "lids",
  "life", "lift", "lilo", "limo", "lino", "locket", "lockets", "lousing", "love", "ludo", "lusting", "macrons",
  "manacle", "manatee", "mangle", "mangled", "mangles", "manhole", "mantel", "mantels", "mantled", "mantles",
  "mantoes", "marinaded", "marinades", "marinara", "marinas", "marinate", "marinated", "marinates", "math",
  "meh", "mend", "mesh", "met", "mete", "meteor", "meteoric", "meteors", "meths", "mistake", "mistaking",
  "mode", "mole", "moonwalk", "mope", "more", "morphed", "morphia", "morphs", "mote", "moth", "moue", "mousing",
  "moved", "mover", "moves", "movie", "mushing", "musing", "musings", "mussing", "myth", "naive", "natives",
  "nave", "negative", "neither", "nether", "nursing", "oatcake", "optimise", "optimised", "optimiser", "optimises",
  "optimist", "optimists", "optimize", "optimum", "optimums", "ora", "orc", "orcs", "other", "ousting", "pacy",
  "panache", "pancaked", "pancakes", "park", "parkland", "part", "partake", "pausing", "pave", "pays", "peaking",
  "penance", "pert", "pinto", "pith", "play", "pocket", "pockets", "poet", "polyglot", "polygonal", "polygons",
  "pore", "pork", "porn", "ports", "post", "pot", "pout", "pray", "prelacy", "prom", "pulsing", "pursing",
  "pushing", "quaking", "racket", "rackets", "radium", "rave", "reconvert", "recross", "redeemed", "redeemer",
  "redeems", "redeposit", "refinance", "relax", "relayed", "relays", "rely", "rend", "repay", "replay", "replays",
  "resupply", "retaking", "retch", "reusing", "rhodium", "rickets", "rickety", "ridge", "rocked", "rocker",
  "rockers", "rockery", "rocketed", "rocketry", "rockets", "rockier", "rockiest", "rort", "rousing", "rove",
  "rushing", "rusting", "sacking", "sake", "sanctums", "sand", "sap", "save", "scaling", "scaring", "seal",
  "sealing", "seaming", "searing", "seating", "seed", "seeking", "self", "sells", "semolina", "sends", "sens",
  "sent", "shacking", "shadier", "shading", "shake", "shaking", "shaming", "shaping", "sharing", "shark",
  "sharking", "shaving", "shell", "sicking", "sill", "sing", "sinking", "skating", "slacking", "slake", "slaking",
  "slander", "slap", "slating", "slaving", "slaying", "smacking", "smell", "smoking", "snacking", "snake",
  "snaking", "snap", "snaring", "sneaking", "soaking", "soakings", "soap", "soaping", "soaring", "socket",
  "sockets", "socking", "solaria", "sort", "sousing", "spacing", "spading", "spake", "spank", "spanking",
  "spar", "spare", "sparing", "sparked", "sparkie", "sparking", "sparkle", "sparkled", "sparkler", "sparklers",
  "sparkles", "sparkling", "sparkly", "sparks", "sparky", "spars", "spay", "spaying", "speaking", "spell",
  "spend", "spiking", "sport", "sprocket", "stabber", "stabbing", "stabler", "stabling", "stacked", "stacking",
  "staffer", "staffing", "stage", "stagger", "stagier", "staging", "stagings", "staider", "staining", "staked",
  "stakes", "stale", "staler", "staling", "stalked", "stalker", "stalking", "stalkings", "stalling", "stamina",
  "stammer", "stamper", "stamping", "standee", "stander", "standers", "standing", "stapler", "stapling",
  "stare", "starer", "starers", "staring", "stark", "starker", "starling", "starring", "starter", "starting",
  "starving", "stashing", "state", "stater", "stating", "stave", "staving", "stayer", "stayers", "staying",
  "steadier", "stealing", "stealth", "steamer", "steaming", "stet", "stets", "stewing", "sticking", "stinking",
  "stocking", "stoke", "stoking", "stoning", "stonking", "storing", "stowing", "strafing", "strawing", "straying",
  "streaking", "stretch", "strewth", "striking", "stroking", "styling", "sucking", "suing", "sulking", "sultana",
  "supple", "suppler", "sussing", "swab", "swag", "swam", "swamp", "swan", "swanking", "swaps", "swat", "sway",
  "swaying", "swell", "tacking", "take", "taking", "takings", "talking", "tanking", "tasking", "teen", "teeth",
  "tell", "ten", "tend", "tether", "tethers", "than", "thee", "thew", "they", "thin", "thorough", "though",
  "thought", "throngs", "tirade", "tirades", "tort", "trace", "trad", "traded", "trader", "traders", "trades",
  "traduce", "transferal", "transfers", "transfix", "transform", "treadle", "trough", "troughs", "uncross",
  "unto", "upswing", "validate", "validated", "validates", "validation", "vase", "velodromes", "vend", "wave",
  "weather", "well", "wend", "when", "whether", "width", "wish", "wit", "witch", "withdrawal", "withdrawn",
  "withdraws", "withdrew", "withe", "wits", "wort", "wove", "yarn", "year", "yearned", "yearns", "years",
  "yell",
  // within one edit of the restaking venue words ("kelp"; "renzo", "rseth" and "ezeth" have none)
  "help", "keep", "kelps", "yelp",
  // within one edit of the savings and stake pool words ("bsol", "susds", "susde"; the others have none)
  "bowl", "suds", "suede",
]);

/** True when `token` (any case) is an English word the corrector must leave as typed. */
export function isEnglishWord(token: string): boolean {
  return ENGLISH_WORDS.has(token.toLowerCase());
}
