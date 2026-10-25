"""Curated vocabularies for the CivicAI NLP engine.

Everything the rule-based parts of ``ai.nlp`` rely on lives here as plain Python data, so it can be
reviewed, unit-tested and extended without touching any algorithm:

* **Stopwords** - English plus romanised Hindi / Telugu function words. Negations ("no", "not",
  "never", "without") and spatial prepositions ("near", "opposite", "behind") are deliberately *not*
  stopwords: "no water" and "near school" carry the meaning of a civic complaint.
* **Synonym tables** - map romanised Hindi ("Hinglish"), romanised Telugu, Devanagari / Telugu
  script words and common Indian-English variants onto one canonical English vocabulary
  (gaddha -> pothole, kachra / chetta -> garbage, nala -> drain, bijli / current -> electricity,
  paani / neeru -> water, chettu -> tree). Multi-word phrases are matched before single words
  ("ke paas" -> near, "neeru ledu" -> no water, "road hole" -> pothole).
* **Lemma table** - light lemmatisation: inflected civic words are mapped to one readable canonical
  form (flooding / flooded -> flood, broke / breaking -> broken). Plurals are handled by a rule in
  ``text_preprocessor`` with the exceptions listed here.
* **Domain term weights** - used by the keyword extractor to prefer civic vocabulary.
* **Spelling key terms** - the long, distinctive domain words that conservative typo correction
  may map to (pothol -> pothole, garbge -> garbage).
"""


def _invert(groups):
    """Turn ``{canonical: [variant, ...]}`` into ``{variant: canonical}``.

    Raises ``ValueError`` if one variant is listed under two different canonical words, so an
    ambiguous edit to the tables fails loudly at import time instead of silently overriding.
    """
    out = {}
    for canonical, variants in groups.items():
        for variant in variants:
            if variant in out and out[variant] != canonical:
                raise ValueError(f"Synonym '{variant}' maps to both '{out[variant]}' and '{canonical}'")
            out[variant] = canonical
    return out


# ---------------------------------------------------------------------------------------------
# Stopwords
# ---------------------------------------------------------------------------------------------
NEGATIONS = frozenset({
    "no", "not", "never", "nothing", "nobody", "none", "neither", "nor", "without", "cannot",
})

ENGLISH_STOPWORDS = frozenset("""
a an the and or but if then else so because as of at by for with about against between into
through during before after above below to from up down in out on off over under again further
once here there when where why how all any both each few more most other some such only own same
than too very can will just should now i me my myself we our ours ourselves you your yours
yourself yourselves he him his himself she her hers herself it its itself they them their theirs
themselves what which who whom whose this that these those am is are was were be been being have
has had having do does did doing would could might must shall may also please kindly pls plz sir
madam mam maam dear respected hello hi team regards thanks thank etc get got getting let lot lots
even really like much every still since yet already ever almost quite rather just soon well
someone something anyone anything everyone everything u ur r im ive id youre theres thats
whats lets one ones another us being via per upon onto while whether either though although
however also around across along towards toward throughout within
""".split())

INDIC_STOPWORDS = frozenset("""
hai hain ho hota hoti hote tha thi ka ki ke ko se pe par mein bhi aur ya yeh ye woh wo iss uss
isko usko isme usme yahan wahan yaha waha jo jab tab kya kyun kyon kaise kuch koi raha rahi rahe
rha rhi rhe gaya gayi gaye gya gyi hua hui hue huwa kar karo kare karein karen karke kiya kiye
kijiye dijiye diya liya lena dena jaata jaati jata jati wala wali wale ji bhai bhaiya sahab saab
abhi ab sab na toh tak liye apne apna apni hamare hamara hamari humara hamko humko mujhe mera meri
mere aap aapka unka unki aa aaya aayi aate aata aati jaa ja rahta rehta rehti lagta lagti laga
lagi hum hamesha bas inke unke iska uska kahin yahi wahi vahi
lo ni nu ga undi unnadi unnai unnayi undhi ayindi aindi avutundi avuthundi chestunnaru cheyandi
chesi chesaru cheyali kosam nunchi nundi varaku valla meeda mida kinda lopala bayata oka ee adi
idi ivi avi mee maa mana memu meeru vaallu vallu andi garu inka emi emiti enduku ela ekkada ikkada
akkada appudu ippudu eppudu mariyu leka ante antha anni konni chesthunnaru chestunnam unnam
untundi vundi vunnadi chesindi cheyyandi cheyadam cheyyadam ayyindi ayyayi avutunnayi
vastundi vastunnayi potundi pothundi chestunnaru pedutunnaru pettaru unnaru wajah evaru evvaru
है हैं के का की को से पर में भी और यह वह था थी हो रहा रही गया गयी हुआ
ఉంది ఉన్నాయి మీద లో కి ని కూడా
""".split())

STOPWORDS = ENGLISH_STOPWORDS | INDIC_STOPWORDS

# Romanised Hindi / Telugu marker words used for language identification. "Strong" markers are
# practically never English words; "weak" ones (ka, ki, ke, lo ...) only count half.
HINDI_STRONG_MARKERS = frozenset("""
hai hain nahi nahin raha rahi rahe gaya gayi kya bahut bohot wala wali kijiye karo karein abhi
kyun kyon mein bhi hua hui hota hoti lekin magar paas saamne samne sadak gaddha gadda khadda kachra
kachara paani bijli nala naala machhar badbu bacche bachche jaldi dobara kutte kutta thik theek
koi kuch hamare hamara mera mere mujhe aap ghar gir toota tuta phata khula dhakkan andhera hafte
mahine din raat bada badi bade chhota sab yahan wahan logon shikayat safai turant
""".split())
HINDI_WEAK_MARKERS = frozenset("ka ki ke ko se pe par ho na ye wo tha thi".split())
TELUGU_STRONG_MARKERS = frozenset("""
undi unnadi unnai ledu ledhu chala chaala daggara dhaggara neeru neellu chettu chetta gunta guntha
gunthalu guntalu roddu pillalu kukkalu cheyandi chesaru vachindi poyindi padindi padipoyindi emi
enduku inka valla meeda pakkana mundu venaka kaani garu andi ekkada ikkada akkada pothundi
avuthundi avutundi kosam nunchi varaku rojulu roju vaaram vaaralu nelalu velagatledu
cheyyatledu cheyatledu pattinchukovatledu kaluva murugu domalu kampu vasana badi baagundi
bagundi baaledu bagaledu tondaraga thondaraga ventane malli
""".split())
TELUGU_WEAK_MARKERS = frozenset("lo ga ni nu ki".split())

LANGUAGE_NAMES = {
    "en": "English",
    "hi-en": "Hinglish (romanised Hindi + English)",
    "te-en": "romanised Telugu + English",
    "hi": "Hindi (Devanagari)",
    "te": "Telugu (Telugu script)",
    "und": "undetermined",
}

# ---------------------------------------------------------------------------------------------
# Synonyms
# ---------------------------------------------------------------------------------------------
# Multi-word phrases (matched first, longest first) -> canonical token sequence.
PHRASE_SYNONYMS = {
    # English compounds and spelling variants
    ("road", "hole"): ("pothole",),
    ("road", "holes"): ("pothole",),
    ("pot", "hole"): ("pothole",),
    ("pot", "holes"): ("pothole",),
    ("man", "hole"): ("manhole",),
    ("man", "holes"): ("manhole",),
    ("street", "light"): ("streetlight",),
    ("street", "lights"): ("streetlight",),
    ("street", "lite"): ("streetlight",),
    ("street", "lamp"): ("streetlight",),
    ("street", "lamps"): ("streetlight",),
    ("lamp", "post"): ("streetlight", "pole"),
    ("lamp", "posts"): ("streetlight", "pole"),
    ("water", "logging"): ("waterlogging",),
    ("water", "logged"): ("waterlogging",),
    ("water", "log"): ("waterlogging",),
    ("dust", "bin"): ("dustbin",),
    ("dust", "bins"): ("dustbin",),
    ("foot", "path"): ("footpath",),
    ("foot", "paths"): ("footpath",),
    ("side", "walk"): ("sidewalk",),
    ("pipe", "line"): ("pipeline",),
    ("pipe", "lines"): ("pipeline",),
    ("over", "flowing"): ("overflow",),
    ("over", "flow"): ("overflow",),
    ("power", "cuts"): ("power", "cut"),
    ("current", "cut"): ("power", "cut"),
    ("load", "shedding"): ("power", "cut"),
    ("next", "to"): ("near",),
    ("close", "to"): ("near",),
    ("adjacent", "to"): ("near",),
    ("right", "outside"): ("near",),
    ("in", "front", "of"): ("front",),
    ("opposite", "to"): ("opposite",),
    ("no", "one"): ("nobody",),
    ("no", "body"): ("nobody",),
    ("bus", "stand"): ("bus", "stop"),
    ("kal", "se"): ("since", "yesterday"),
    ("ninna", "nunchi"): ("since", "yesterday"),
    ("x", "roads"): ("junction",),
    ("x", "road"): ("junction",),
    ("cross", "roads"): ("junction",),
    ("nt", "working"): ("not", "working"),
    ("nt", "wrking"): ("not", "working"),
    # Hinglish (romanised Hindi)
    ("ke", "paas"): ("near",),
    ("ke", "pas"): ("near",),
    ("ke", "bagal", "mein"): ("near",),
    ("ke", "bagal"): ("near",),
    ("ke", "saamne"): ("front",),
    ("ke", "samne"): ("front",),
    ("ke", "peeche"): ("behind",),
    ("ke", "andar"): ("inside",),
    ("paani", "nahi", "aa", "raha"): ("no", "water"),
    ("pani", "nahi", "aa", "raha"): ("no", "water"),
    ("paani", "nahi", "aata"): ("no", "water"),
    ("paani", "nahi"): ("no", "water"),
    ("pani", "nahi"): ("no", "water"),
    ("bijli", "nahi"): ("no", "electricity"),
    ("light", "nahi"): ("no", "light"),
    ("bijli", "chali", "gayi"): ("power", "cut"),
    ("bijli", "gayi"): ("power", "cut"),
    ("light", "gayi"): ("power", "cut"),
    ("paani", "bhar", "gaya"): ("waterlogging",),
    ("pani", "bhar", "gaya"): ("waterlogging",),
    ("paani", "bhara"): ("waterlogging",),
    ("pani", "bhara"): ("waterlogging",),
    ("paani", "jama"): ("waterlogging",),
    ("pani", "jama"): ("waterlogging",),
    ("gir", "gaya"): ("fallen",),
    ("gir", "gayi"): ("fallen",),
    ("gir", "gaye"): ("fallen",),
    ("gir", "pada"): ("fallen",),
    ("gir", "padi"): ("fallen",),
    ("toot", "gaya"): ("broken",),
    ("toot", "gayi"): ("broken",),
    ("tut", "gaya"): ("broken",),
    ("phat", "gaya"): ("burst",),
    ("phat", "gayi"): ("burst",),
    ("fat", "gaya"): ("burst",),
    ("kuch", "nahi", "kiya"): ("nothing", "done"),
    ("kuch", "nahi", "hua"): ("nothing", "happened"),
    ("koi", "action", "nahi"): ("no", "action"),
    ("koi", "sunta", "nahi"): ("no", "response"),
    ("koi", "dhyan", "nahi"): ("no", "action"),
    ("kai", "baar"): ("many", "times"),
    ("bahut", "baar"): ("many", "times"),
    ("chala", "sarlu"): ("many", "times"),
    ("chaala", "sarlu"): ("many", "times"),
    ("anni", "sarlu"): ("many", "times"),
    ("baar", "baar"): ("repeatedly",),
    ("bar", "bar"): ("repeatedly",),
    ("phir", "se"): ("again",),
    ("fir", "se"): ("again",),
    ("jagah", "jagah"): ("everywhere",),
    ("beh", "raha"): ("flow",),
    ("beh", "rahi"): ("flow",),
    ("theek", "karo"): ("fix",),
    ("thik", "karo"): ("fix",),
    ("theek", "kijiye"): ("fix",),
    ("thik", "kijiye"): ("fix",),
    ("theek", "karwao"): ("fix",),
    ("theek", "nahi"): ("not", "fixed"),
    ("thik", "nahi"): ("not", "fixed"),
    ("saaf", "nahi"): ("not", "clean"),
    ("safai", "nahi"): ("not", "clean"),
    ("kaam", "nahi", "kar", "raha"): ("not", "working"),
    ("kaam", "nahi", "kar", "rahi"): ("not", "working"),
    ("kaam", "nahi"): ("not", "working"),
    ("band", "hai"): ("off",),
    ("band", "pada"): ("off",),
    ("dhakkan", "nahi"): ("no", "cover"),
    ("dhakkan", "gayab"): ("no", "cover"),
    # romanised Telugu
    ("neeru", "ledu"): ("no", "water"),
    ("neellu", "ledu"): ("no", "water"),
    ("neellu", "raavadam", "ledu"): ("no", "water"),
    ("neeru", "raavadam", "ledu"): ("no", "water"),
    ("neellu", "raavatledu"): ("no", "water"),
    ("neeru", "raavatledu"): ("no", "water"),
    ("current", "ledu"): ("no", "electricity"),
    ("current", "poyindi"): ("power", "cut"),
    ("current", "pothundi"): ("power", "cut"),
    ("light", "ledu"): ("no", "light"),
    ("lights", "levu"): ("no", "light"),
    ("pani", "cheyyatledu"): ("not", "working"),
    ("pani", "cheyatledu"): ("not", "working"),
    ("pani", "cheyyadam", "ledu"): ("not", "working"),
    ("pani", "cheyadam", "ledu"): ("not", "working"),
    ("work", "avvatledu"): ("not", "working"),
    ("neeru", "nilichi"): ("waterlogging",),
    ("neellu", "nilichi"): ("waterlogging",),
    ("neellu", "nilichipoyayi"): ("waterlogging",),
    ("kinda", "padindi"): ("fallen",),
    ("kinda", "paddadi"): ("fallen",),
    ("evvaru", "pattinchukovadam", "ledu"): ("no", "action"),
    ("evaru", "pattinchukovatledu"): ("no", "action"),
    ("action", "teesukoledu"): ("no", "action"),
    ("malli", "malli"): ("repeatedly",),
    ("baagu", "cheyandi"): ("fix",),
    ("moota", "ledu"): ("no", "cover"),
    ("mootha", "ledu"): ("no", "cover"),
}

# Single words -> canonical English word. Romanised Hindi/Telugu, native-script words and common
# Indian-English / texting variants. Generic synonyms (big -> large, outside -> near) make
# paraphrases such as "Big road pothole outside school" share vocabulary with "Large pothole near
# school" in the TF-IDF space.
WORD_SYNONYMS = _invert({
    # --- civic issue vocabulary ---------------------------------------------------------------
    "pothole": ["gaddha", "gadda", "gaddhe", "gadde", "gadha", "gadhe", "gaddhaa", "khadda", "khadde",
                "khaddha", "khaddhe", "gunta", "guntha", "guntalu", "gunthalu", "gunte", "potholl",
                "गड्ढा", "गड्ढे", "खड्डा", "గుంత", "గుంతలు"],
    "road": ["sadak", "sadke", "sadkon", "sarak", "sadakh", "rasta", "raasta", "rastaa", "rastha",
             "roddu", "rodlu", "rd", "सड़क", "रास्ता", "రోడ్డు", "రోడ్"],
    "lane": ["gali", "galli", "gully"],
    "street": ["veedhi", "vidhi", "veedi"],
    "garbage": ["kachra", "kachara", "kachda", "kachre", "kachraa", "kooda", "koodaa", "chetta",
                "chettha", "cheththa", "trash", "rubbish", "कचरा", "कूड़ा", "చెత్త"],
    "dustbin": ["dustbins", "dumpster", "dumpsters", "kudedaan", "kooredaan"],
    "drain": ["nala", "naala", "naali", "nali", "gutter", "gutters", "kaluva", "kaluvalu", "nalaa",
              "नाला", "नाली", "కాలువ"],
    "sewage": ["sewer", "sewers", "sewerage", "murugu", "मल"],
    "waterlogging": ["waterlogged", "waterlog", "jalbharav"],
    "electricity": ["bijli", "bijlee", "bijali", "karent", "current", "vidyut", "vidyuth", "बिजली",
                    "కరెంట్", "కరెంటు"],
    "light": ["batti", "lite", "lyt", "lightu", "lightlu", "बत्ती", "లైట్"],
    "streetlight": ["streetlite", "streetlamp", "streetlamps", "streetlights"],
    "pole": ["khamba", "khambha", "stambham", "खंभा", "స్తంభం"],
    "wire": ["taar", "taaron", "teegalu", "teega"],
    "water": ["paani", "pani", "paanee", "jal", "neeru", "neellu", "neelu", "पानी", "నీరు", "నీళ్లు"],
    "tree": ["ped", "pedh", "paed", "pedon", "darakht", "chettu", "chetlu", "chettlu", "पेड़", "చెట్టు"],
    "branch": ["daali", "daaliyan", "tahni", "tehni", "komma", "kommalu"],
    "fallen": ["gira", "giri", "gire", "padipoyindi", "padindi", "kulipoyindi", "padipothunnaru",
               "padutunnaru", "padipoyaru", "paddaru", "गिरा", "పడిపోయింది"],
    "broken": ["toota", "tuta", "tooti", "tuti", "toote", "tute", "virigindi", "virigipoyindi",
               "brkn", "टूटा"],
    "burst": ["phata", "phati", "phate", "pagilindi", "pagilipoyindi"],
    "crack": ["daraar", "darar", "daraarein", "pagulu", "pagullu", "beetalu", "beeta"],
    "open": ["khula", "khuli", "khule", "khulla", "khulle", "terichi", "therichi"],
    "cover": ["dhakkan", "dhakan", "dhakna", "moota", "mootha", "lid", "lids", "slab"],
    "dark": ["andhera", "andhere", "andheraa", "cheekati", "chikati", "andhkar"],
    "night": ["raat", "raatri", "ratri", "rathri"],
    "day": ["din", "dino", "dinon", "roju", "rojulu", "rojuluga", "dinalu"],
    "week": ["hafte", "hafta", "hafton", "hapta", "hapte", "vaaram", "varam", "vaaralu", "varalu"],
    "month": ["mahine", "mahina", "mahino", "mahinon", "nela", "nelalu"],
    "year": ["saal", "samvatsaram", "samvatsaralu"],
    # --- size / position -----------------------------------------------------------------------
    "large": ["big", "bada", "bade", "bda", "pedda", "peddha", "peddaga", "bigg", "बड़ा", "बड़ी", "పెద్ద"],
    "small": ["chhota", "chota", "chhoti", "choti", "chhote", "chote", "chinna", "chinnadi"],
    "very": ["bahut", "bohot", "bahot", "bohat", "bhot", "chala", "chaala", "chaalaa", "ekkuva", "बहुत", "చాలా"],
    "near": ["outside", "nearby", "beside", "nazdeek", "najdeek", "kareeb", "daggara", "dhaggara",
             "daggra", "pakkana", "paas", "पास", "దగ్గర"],
    "front": ["saamne", "samne", "samane", "mundu", "munde"],
    "behind": ["peeche", "piche", "peechhe", "venaka", "venakala"],
    # --- people / places -------------------------------------------------------------------------
    "child": ["bacche", "bachche", "bachhe", "bachon", "bacchon", "bachchon", "bachcha", "baccha",
              "bache", "pillalu", "pilla", "pillala", "kids", "kid", "बच्चे", "పిల్లలు"],
    "elderly": ["buzurg", "bujurg", "budhe", "boodhe", "bujurgon", "peddavallu", "musalivallu",
                "aged"],
    "woman": ["aurat", "aurten", "mahila", "mahilayen", "ladkiyan", "aadavallu"],
    "people": ["logon", "janalu", "prajalu"],
    "school": ["vidyalaya", "pathshala", "paathshala", "paathasala", "pathasala", "स्कूल", "స్కూల్"],
    "hospital": ["aspatal", "aspataal", "haspatal", "aasupatri", "aasupathri", "asupatri",
                 "hospitl", "अस्पताल", "ఆసుపత్రి"],
    "market": ["bazaar", "bazar", "baazar", "baazaar", "mandi", "santha"],
    "junction": ["chauraha", "chouraha", "chowrasta", "chowrastha", "chaurasta", "chourasta",
                 "crossroads", "jn", "jnc"],
    "temple": ["mandir", "gudi", "aalayam", "alayam"],
    "mosque": ["masjid", "masjeed"],
    "church": ["girja"],
    "house": ["ghar", "gharon", "makaan", "makan", "illu", "intlo", "illulu", "inti"],
    "wall": ["deewar", "diwar", "deewaar", "goda"],
    "shop": ["dukaan", "dukan", "dukaanein", "kottu", "angadi"],
    "vehicle": ["gaadi", "gaadiyan", "gadiyan", "gaadiyon", "bandi", "bandlu", "vehicals"],
    "government": ["govt", "sarkari", "prabhutva"],
    # --- hazards / impacts ---------------------------------------------------------------------
    "mosquito": ["machhar", "machar", "macchar", "machchar", "machhron", "macharon", "domalu", "doma",
                 "मच्छर", "దోమలు"],
    "smell": ["badbu", "badboo", "badbo", "durgandh", "bdbu", "vasana", "बदबू"],
    "stink": ["kampu", "kaampu"],
    "disease": ["bimari", "bimaari", "beemari", "bimariyan", "rogalu", "jabbulu"],
    "accident": ["hadsa", "haadsa", "haadse", "hadse", "durghatna", "pramadam", "pramaadam",
                 "हादसा", "ప్రమాదం"],
    "dangerous": ["khatarnak", "khatarnaak", "khatranak", "pramadakaram", "खतरनाक"],
    "danger": ["khatra", "khatara", "khatre"],
    "injury": ["chot", "chotein", "debba", "gayalu"],
    "urgent": ["jaldi", "turant", "fauran", "foran", "jald", "tondaraga", "thondaraga", "ventane",
               "asap", "urgently"],
    "again": ["dobara", "dubara", "malli", "mallee"],
    "complaint": ["shikayat", "shikayath", "shikayaten", "phiryadu", "firyadu"],
    "clean": ["safai", "saaf", "saafai", "subhram"],
    "okay": ["theek", "thik", "ok", "oky"],
    # --- animals / other civic issues ------------------------------------------------------------
    "dog": ["kutta", "kutte", "kutton", "kuttey", "kuttha", "kukka", "kukkalu", "kukkal", "कुत्ते",
            "कुत्ता", "కుక్కలు"],
    "monkey": ["bandar", "bandaron", "kothi", "kothulu", "kotulu"],
    "cow": ["gaay", "gaiya", "aavu", "aavulu"],
    "cattle": ["maveshi", "pashu", "pashuon"],
    "pig": ["suar", "suwar", "pandulu"],
    "noise": ["shor", "shorr", "shorgul", "sabdham", "shabdam", "sound"],
    "encroachment": ["kabza", "kabja", "aakramana"],
    "stray": ["awara", "aawara", "avara"],
    "bite": ["kaat", "kaatna", "karustunnayi", "karichindi", "kaata"],
    "dirty": ["ganda", "gandha", "gandi", "gande", "murikiga", "muriki"],
    "hang": ["latak", "latka", "latki", "veladutundi"],
    "rain": ["baarish", "barish", "varsham", "vaana"],
    "storm": ["aandhi", "toofan", "gaali", "galivaana"],
    "dry": ["sukha", "sookha", "endipoyina"],
    "new": ["nayi", "naya", "naye", "kotha", "kottha"],
    "everywhere": ["antha", "everywere"],
    "fear": ["darr", "dar", "bhayam", "bayam"],
    "tap": ["nal", "nalka", "kulai", "kolai", "kulayi"],
    "flow": ["beh", "paruthundi", "parutundi", "prava"],
    "throw": ["phenk", "phek", "padestunnaru", "vestunnaru"],
    "roam": ["ghoomti", "ghoomte", "ghoom", "tirugutunnayi", "tirugutunnai"],
    "buffalo": ["bhains", "bhainsen", "barrelu", "gedelu"],
    "damage": ["paadaipoyindi", "padaipoyindi", "kharab", "kharaab", "nashta"],
    "slip": ["jaaripotunnayi", "jaripotunnayi", "jaaruthundi", "fisal", "phisal"],
    "dump": ["kuppa", "dher", "dheer"],
    "waste": ["barbaad", "barbad", "vruthaga", "vrudha"],
    "trouble": ["ibbandi", "pareshan", "pareshaan", "dikkat", "takleef"],
    "lie": ["pada", "padi", "pade", "padiundi"],
    # --- negation / texting ----------------------------------------------------------------------
    "not": ["nahi", "nahin", "nhi", "nai", "ledu", "ledhu", "kaadu", "nt", "levu", "नहीं", "లేదు"],
    "not done": ["cheyaledu", "cheyyaledu", "cheyyaledhu"],
    "nobody came": ["raaledu", "raledu"],
    "nothing done": ["kuchnahi"],
    "working": ["wrking", "wrkng", "workin"],
})

# Telugu context overrides: words that mean something else in Hindi.
#   badi: "big" (Hindi, feminine) vs "school" (Telugu);  pani: "water" (Hindi) vs "work" (Telugu)
TELUGU_OVERRIDES = {"badi": "school", "pani": "work"}
HINDI_OVERRIDES = {"badi": "large"}

# ---------------------------------------------------------------------------------------------
# Light lemmatisation
# ---------------------------------------------------------------------------------------------
LEMMA_TABLE = _invert({
    "broken": ["broke", "break", "breaks", "breaking", "breakage", "breakages"],
    "fallen": ["fell", "fall", "falls", "falling"],
    "blocked": ["blocking", "blockage", "blockages", "blocks"],
    "flood": ["flooded", "flooding", "floods"],
    "leak": ["leaking", "leaked", "leaks", "leakage", "leakages", "leaky"],
    "overflow": ["overflowing", "overflowed", "overflows", "overflown"],
    "damage": ["damaged", "damaging", "damages"],
    "collect": ["collected", "collecting", "collection", "collects", "collections"],
    "work": ["worked", "works"],
    "uproot": ["uprooted", "uprooting"],
    "crack": ["cracked", "cracking", "cracks"],
    "burst": ["bursting", "bursted", "bursts"],
    "dump": ["dumped", "dumping", "dumps"],
    "burn": ["burning", "burnt", "burned", "burns"],
    "smell": ["smelling", "smells", "smelly"],
    "stink": ["stinking", "stinks", "stinky", "stench"],
    "injury": ["injured", "injuries", "injuring", "injure"],
    "electrocution": ["electrocuted", "electrocute", "electrocuting"],
    "spark": ["sparking", "sparks", "sparked"],
    "flicker": ["flickering", "flickers", "flickered"],
    "hang": ["hanging", "hung", "hangs"],
    "lie": ["lying", "lies"],
    "choke": ["choked", "choking", "chokes"],
    "clog": ["clogged", "clogging", "clogs"],
    "stagnant": ["stagnated", "stagnating", "stagnation"],
    "contaminated": ["contamination", "contaminating", "contaminate"],
    "pollution": ["polluted", "polluting", "pollute"],
    "repair": ["repaired", "repairing", "repairs"],
    "fix": ["fixed", "fixing"],
    "resolve": ["resolved", "resolving"],
    "complaint": ["complaints", "complained", "complaining", "complain"],
    "attack": ["attacked", "attacking", "attacks"],
    "bite": ["biting", "bitten", "bites"],
    "cover": ["covered", "covering", "covers"],
    "sink": ["sinking", "sunk", "sank"],
    "walk": ["walking", "walked", "walks"],
    "drive": ["driving", "drove", "driven"],
    "ride": ["riding", "rode"],
    "bark": ["barking", "barks"],
    "roam": ["roaming", "roams"],
    "chase": ["chasing", "chased"],
    "wait": ["waiting", "waited"],
    "delay": ["delayed", "delays", "delaying"],
    "jam": ["jammed", "jamming", "jams"],
    "slip": ["slipped", "slipping"],
    "skid": ["skidded", "skidding"],
    "die": ["died", "dying", "dies"],
    "child": ["children", "childrens"],
    "people": ["peoples"],
    "woman": ["women"],
    "man": ["men"],
    "foot": ["feet"],
    "leaf": ["leaves"],
    "life": ["lives"],
    "bus": ["buses", "busses"],
    "mosquito": ["mosquitoes", "mosquitos"],
    "accumulate": ["accumulated", "accumulating", "accumulation"],
    "spread": ["spreading", "spreads"],
    "stray": ["strays"],
    "encroachment": ["encroached", "encroaching", "encroachments", "encroach"],
    "disrupt": ["disrupted", "disrupting", "disruption"],
    "disconnect": ["disconnected", "disconnecting", "disconnection"],
    "enter": ["entering", "entered", "enters"],
    "affect": ["affected", "affecting", "affects"],
    "cause": ["caused", "causing", "causes"],
    "suffer": ["suffering", "suffered", "suffers"],
    "remove": ["removed", "removing"],
    "clear": ["cleared", "clearing"],
    "clean": ["cleaned", "cleaning"],
    "replace": ["replaced", "replacing"],
    "dig": ["dug", "digging"],
    "pile": ["piled", "piling", "piles"],
    "breed": ["breeding", "breeds"],
    "drip": ["dripping", "dripped", "drips"],
    "waste": ["wasted", "wasting", "wastage"],
    "lean": ["leaning", "leaned", "leans"],
    "tilt": ["tilting", "tilted", "tilts"],
    "divert": ["diverted", "diverting", "diversion"],
    "rot": ["rotting", "rotten", "rots"],
    "snatch": ["snatching", "snatched"],
    "interrupt": ["interrupted", "interruption", "interruptions"],
})

# Words the plural-stripping rule must leave alone.
LEMMA_EXCEPTIONS = frozenset("""
bus gas has was yes its always news series species status campus virus bonus axis crisis basis
analysis physics lens plus thus perhaps bias atlas canvas christmas diabetes rabies measles herpes
mess less loss pass glass grass class cross address process access across chess dress boss gross
this tennis police premises various previous serious dangerous nervous famous anonymous
continuous mischievous obvious hazardous numerous enormous tremendous religious jealous
ridiculous generous vigorous rigorous gracious precious spacious delicious conscious anxious
hopeless useless careless helpless homeless pointless endless worthless reckless restless
nevertheless business wilderness darkness illness sickness happiness kindness awareness
fitness wellness cleanliness unless guess miss kiss fuss bliss canvass dismiss
""".split())

# ---------------------------------------------------------------------------------------------
# Spelling correction
# ---------------------------------------------------------------------------------------------
# Distinctive domain words (>= 6 letters) that an out-of-vocabulary token may be corrected to when
# it is within Damerau-Levenshtein distance 1 (2 for words of 8+ letters) and starts with the
# same letter. Short words are excluded on purpose ("drawn" must not become "drain").
SPELLING_KEY_TERMS = (
    "pothole", "garbage", "drainage", "streetlight", "manhole", "electricity", "electric", "sewage",
    "mosquito", "overflow", "overflowing", "leakage", "pipeline", "waterlogging", "transformer",
    "footpath", "accident", "hospital", "children", "dustbin", "uprooted", "dangerous", "pedestrian",
    "wheelchair", "pollution", "sanitation", "electrocution", "junction", "blocked", "flooded",
    "damaged", "repaired", "complaint", "collected",
)
# Real English words that sit within edit distance of a key term and must never be "corrected".
SPELLING_PROTECTED = frozenset("""
garage garages transformed transforms hospitable hospitality complains compliant complained
flooring floored blocker damages damager electrics function junctions repainted corrected
connected collector collectors collects
""".split())

# ---------------------------------------------------------------------------------------------
# Keyword extraction: domain vocabulary
# ---------------------------------------------------------------------------------------------
# Canonical (lemmatised) term -> boost weight in [0, 1].
#   1.0 core category vocabulary, 0.8 hazards / sensitive places / named civic issues,
#   0.6 impact vocabulary, 0.3 generic civic nouns.
DOMAIN_TERMS = {
    **{t: 1.0 for t in (
        "pothole", "crater", "pit", "garbage", "dustbin", "debris", "dump", "waste", "drain",
        "drainage", "sewage", "waterlogging", "overflow", "flood", "streetlight", "electricity",
        "wire", "pole", "transformer", "bulb", "light", "water", "leak", "pipeline", "pipe", "tap",
        "valve", "manhole", "cover", "crack", "asphalt", "tree", "branch", "uproot", "fallen",
        "burst", "uncovered", "broken", "blocked", "dark",
    )},
    **{t: 0.8 for t in (
        "accident", "injury", "child", "school", "hospital", "elderly", "electrocution", "danger",
        "dangerous", "fire", "spark", "mosquito", "dengue", "malaria", "smell", "stink", "disease",
        "traffic", "jam", "junction", "highway", "market", "temple", "metro", "footpath",
        "pedestrian", "wheelchair", "dog", "stray", "cattle", "cow", "monkey", "pig", "noise",
        "loudspeaker", "parking", "encroachment", "hawker", "vendor", "bench", "hoarding", "toilet",
        "signboard", "construction", "flicker", "contaminated", "stagnant", "bite", "attack",
        "collapse", "power", "outage", "supply", "pressure",
    )},
    **{t: 0.6 for t in (
        "vehicle", "bike", "car", "bus", "damage", "house", "shop", "wall", "pollution", "plastic",
        "burn", "smoke", "health", "safety", "risk", "night", "rain", "colony", "park", "playground",
        "station", "stop", "signal", "cut",
    )},
    **{t: 0.3 for t in ("road", "street", "lane", "area")},
}

# Domain phrases (canonical, lemmatised) that are better keywords than their parts.
DOMAIN_PHRASES = {
    "open manhole": 1.0, "live wire": 1.0, "stray dog": 0.9, "power cut": 0.9, "water supply": 0.8,
    "main road": 0.7, "bus stop": 0.7, "metro station": 0.7, "traffic jam": 0.8, "drinking water": 0.8, "sewage water": 0.8, "illegal parking": 0.9,
    "noise pollution": 0.9, "fallen tree": 0.9, "electric pole": 0.9, "drain cover": 0.9,
    "manhole cover": 0.9, "stagnant water": 0.8, "dirty water": 0.8, "water leak": 0.9,
    "pipeline leak": 0.9, "garbage dump": 0.8, "road crack": 0.9, "speed breaker": 0.7,
    "short circuit": 0.9, "vegetable market": 0.8, "fish market": 0.8, "railway station": 0.7,
    "electric wire": 0.9, "water pipeline": 0.9, "drainage water": 0.8, "construction debris": 0.8,
}

# Words that are never good keywords on their own (too generic for an officer to act on).
KEYWORD_EXCLUDE = frozenset("""
near front behind opposite inside large small huge big very problem issue complaint cause please
side day week month year time today yesterday morning evening daily also lot many people person
area place thing kind sort way part number make made making take taken give given need needs
needed want wanted come came coming go going went see seen look looking tell told say said know
okay fix repair request action immediate immediately urgent urgently soon quickly again everywhere
repeatedly not no nobody nothing never without since still regard respect kindly sir madam help
due one two three four five six seven eight nine ten dear hello attention notice report
reported concerned authority authorities department officer officers municipal corporation ghmc
local nearby many several whole entire completely totally properly proper new old last first
second third even every
""".split())
