"""Reproducible generator for the CivicAI NLP corpora.

Run from ``backend/``::

    venv/Scripts/python.exe -m ai.nlp.data.build_corpus

Writes (both files are committed so training is reproducible without running this script):

``complaint_corpus.csv`` (columns ``text,label,severity``)
    Synthetic citizen complaints for the 9 civic classes, ``ROWS_PER_CLASS`` rows each. Every row is
    composed from slot templates - an issue phrase, an optional landmark (school, hospital, market,
    junction, temple, metro station ...), an optional duration ("for 2 weeks", "since 10 days"), an
    optional consequence / hazard (accident, children, elderly, live wire, flooding, mosquitoes) and
    an optional request ("please fix urgently", "complained many times"). About 70% of rows are
    Indian English, ~17% Hinglish (romanised Hindi + English) and ~13% romanised Telugu + English.
    Lengths range from a texting-style fragment ("big pothole near bus stop") to three-sentence
    reports; ~15% of rows receive realistic typos. The "other" class holds genuine civic issues that
    belong to no specific category (stray dogs, noise, illegal parking, encroachment, broken bench).

    ``severity`` (low / medium / high / critical) is derived from the *generator's own* knowledge of
    the slots it inserted - class base level, size words (huge / deep vs small), the strongest
    hazard consequence, vulnerable landmarks (school / hospital / children) and long durations for
    accumulating problems - independently of the NLP code, so it can be used to evaluate the
    text severity hint.

``feedback_corpus.csv`` (columns ``text,label``)
    Hand-curated citizen feedback sentences (positive / neutral / negative) written in the style of
    post-resolution comments, including negations, but-clauses, intensifiers, emoji, Hinglish and
    romanised Telugu. Used to evaluate the sentiment analyser.

``complaint_challenge.csv`` (columns ``text,label``)
    90 hand-written complaints (10 per class) whose wording was written independently of the
    templates above (new verbs, landmarks, idioms, unseen words such as "gulmohar", "fissures").
    They are never used for training: ``scripts/train_text_classifier.py`` reports accuracy on them
    as an honest estimate of how the classifier generalises beyond the template distribution.

``feedback_challenge.csv`` (columns ``text,label``)
    60 further feedback sentences written after the sentiment lexicon was finished, deliberately
    using phrasing the lexicon does not contain ("spotless", "shoddy", "washed away", "turned up").
    Evaluation only: it measures how the lexicon generalises, and is never used to tune it.

Determinism: a single ``random.Random(SEED)`` drives every choice; only lists / dicts (never sets)
are iterated, so the output is byte-identical on every run and platform.
"""
import csv
import random
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent
COMPLAINT_CSV = DATA_DIR / "complaint_corpus.csv"
FEEDBACK_CSV = DATA_DIR / "feedback_corpus.csv"
CHALLENGE_CSV = DATA_DIR / "complaint_challenge.csv"
FEEDBACK_CHALLENGE_CSV = DATA_DIR / "feedback_challenge.csv"

SEED = 20261017
ROWS_PER_CLASS = 96
LEVELS = ["low", "medium", "high", "critical"]
LANGUAGE_WEIGHTS = (("en", 0.70), ("hi", 0.17), ("te", 0.13))

# ------------------------------------------------------------------------------------------------
# Shared slots. Places carry a sensitivity: 0 ordinary, 1 busy / high-traffic, 2 vulnerable people.
# ------------------------------------------------------------------------------------------------
PLACES_EN = [
    ("near the government school", 2), ("outside the Zilla Parishad high school", 2),
    ("in front of the primary school gate", 2), ("near the school entrance", 2),
    ("near the children's park", 2), ("near the anganwadi centre", 2), ("near the old age home", 2),
    ("near the government hospital", 2), ("outside the city hospital", 2),
    ("in front of the primary health centre", 2), ("near the maternity hospital", 2),
    ("near the vegetable market", 1), ("in front of the fish market", 1), ("at the Rythu Bazar entrance", 1),
    ("at the main junction", 1), ("near the bus stop", 1), ("at the bus depot junction", 1),
    ("near the metro station", 1), ("below metro pillar no. 1045", 1), ("beside the Hanuman temple", 1),
    ("near the masjid", 1), ("opposite the church", 1), ("on the main road", 1), ("on the service road", 1),
    ("near the railway station", 1), ("on the 100 feet road", 1), ("near the petrol bunk", 1),
    ("at the signal near the flyover", 1), ("on the highway service lane", 1),
    ("in our colony", 0), ("in the 3rd cross lane", 0), ("near my house", 0),
    ("in front of the apartment gate", 0), ("near the community hall", 0), ("behind the post office", 0),
    ("in Ward 12", 0), ("at Plot 45, Sai Nagar", 0), ("near the water tank", 0),
    ("next to the ration shop", 0), ("in Gandhi Nagar 2nd street", 0), ("near Shanti Colony arch", 0),
    ("in Lakshmi Nagar lane 4", 0), ("behind the function hall", 0), ("near the bank ATM", 0),
]
PLACES_HI = [
    ("school ke paas", 2), ("sarkari school ke saamne", 2), ("hospital ke saamne", 2),
    ("aspatal ke paas", 2), ("bacchon ke park ke paas", 2), ("market ke paas", 1),
    ("sabzi mandi ke saamne", 1), ("bus stop ke paas", 1), ("mandir ke bagal mein", 1),
    ("main road pe", 1), ("metro station ke neeche", 1), ("chauraha pe", 1),
    ("hamari gali mein", 0), ("colony mein", 0), ("ghar ke saamne", 0), ("ration dukaan ke paas", 0),
]
PLACES_TE = [
    ("school daggara", 2), ("government school mundu", 2), ("hospital mundu", 2),
    ("aasupatri daggara", 2), ("pillala park daggara", 2), ("market daggara", 1),
    ("rythu bazar daggara", 1), ("bus stop pakkana", 1), ("gudi daggara", 1), ("main road meeda", 1),
    ("metro station kinda", 1), ("junction daggara", 1), ("maa colony lo", 0), ("maa veedhi lo", 0),
    ("maa illu mundu", 0), ("ration shop pakkana", 0),
]
DURATIONS_EN = [
    ("since yesterday", 1), ("for 2 days", 2), ("from 3 days", 3), ("for the past 4 days", 4),
    ("for one week", 7), ("since last week", 7), ("since 10 days", 10), ("for 2 weeks", 14),
    ("since 15 days", 15), ("since the last rains", 20), ("for almost a month", 30),
    ("since last month", 30), ("for more than 3 months", 90), ("for 6 months now", 180),
    ("for a long time", 60),
]
DURATIONS_HI = [
    ("kal se", 1), ("2 din se", 2), ("4 din se", 4), ("ek hafte se", 7), ("10 din se", 10),
    ("do hafte se", 14), ("ek mahine se", 30), ("kai mahino se", 90),
]
DURATIONS_TE = [
    ("ninna nunchi", 1), ("2 rojulu ga", 2), ("4 rojula nunchi", 4), ("oka vaaram nunchi", 7),
    ("10 rojula nunchi", 10), ("rendu vaaralu ga", 14), ("oka nela nunchi", 30),
    ("chala nelalu ga", 90),
]
OPENERS_EN = [
    "Sir, ", "Respected sir/madam, ", "Hello team, ", "Dear municipal team, ",
    "This is to bring to your notice that ", "I want to report that ", "Urgent: ", "Complaint: ",
    "Please note, ", "Kindly attend: ", "Good morning, ",
]
REQUESTS_EN = [
    "Please fix it urgently.", "Kindly take immediate action.", "Please look into this.",
    "Request the concerned department to repair it soon.", "Hope it gets fixed this time.",
    "Complained many times but no action.", "Already complained twice, nobody came.",
    "Pls do the needful.", "Please send someone to check.",
    "This is the third complaint about the same issue.", "Waiting for a quick response.",
    "Please treat this as an emergency.", "Kindly resolve at the earliest.",
    "Requesting immediate attention.", "Please do something before someone gets hurt.",
]
REQUESTS_HI = [
    "Jaldi theek karo please.", "Kripya jaldi action lijiye.", "Koi action nahi ho raha.",
    "Kai baar shikayat ki hai.", "Please dekhiye.", "Turant kuch kijiye.",
]
REQUESTS_TE = [
    "Tondaraga fix cheyandi please.", "Dayachesi action teesukondi.",
    "Chala sarlu complaint chesamu, evaru pattinchukovatledu.", "Please chudandi.",
    "Ventane repair cheyandi.",
]

# ------------------------------------------------------------------------------------------------
# Class definitions.
#   base: base severity index (0 low .. 3 critical);  accumulates: long durations raise severity
#   sizes: (word, severity delta) inserted at {size};  core: English issue phrases
#   effects: (consequence sentence, severity delta);  hi / te: full sentence templates
# ------------------------------------------------------------------------------------------------
CLASSES = {
    "pothole": {
        "base": 1, "accumulates": False,
        "sizes": [("", 0), ("big ", 0), ("huge ", 1), ("large ", 0), ("deep ", 1), ("small ", -1),
                  ("massive ", 1), ("dangerous ", 1)],
        "core": [
            "{a}{size}pothole on the road", "{size}potholes all over the road",
            "there is {a}{size}pothole in the middle of the road", "{a}{size}pit on the road",
            "the road has {a}{size}hole in the middle", "{a}{size}crater formed on the road after the rains",
            "{a}{size}pothole filled with rain water", "the road caved in and {a}{size}pothole has formed",
            "multiple potholes on this stretch", "the road is full of potholes",
            "{a}{size}pothole right at the turning", "the pothole dug for pipeline work was never closed",
            "broken road with {size}potholes", "{a}{size}pothole near the speed breaker",
            "potholes everywhere, the road is broken", "{a}{size}road hole that keeps getting bigger",
        ],
        "effects": [
            ("vehicles are getting damaged", 0), ("two wheelers are skidding and falling", 1),
            ("an accident happened here last week", 1), ("a bike rider fell yesterday and got injured", 2),
            ("it is not visible at night", 1), ("auto drivers swerve suddenly to avoid it", 0),
            ("it is causing heavy traffic jam during peak hours", 0),
            ("rain water fills it and people cannot see how deep it is", 1),
            ("buses slow down and traffic piles up", 0), ("school children cross here every day", 1),
            ("my car tyre burst because of it", 1), ("elderly people find it difficult to walk", 0),
        ],
        "hi": [
            "{place} bada gaddha hai", "{place} sadak pe bahut gaddhe hain {dur}",
            "{dur} {place} road pe khadda hai, koi theek nahi kar raha",
            "road toot gayi hai aur {place} bada gaddha ban gaya hai",
            "{place} gaddhe ki wajah se roz accident ho rahe hain",
            "gaddha itna bada hai ki bike gir jaati hai {place}",
        ],
        "te": [
            "{place} pedda gunta undi", "{place} roddu meeda chala guntalu unnayi {dur}",
            "{dur} {place} road lo gunta undi, evaru pattinchukovatledu",
            "{place} gunta valla bikes padipotunnayi", "roddu antha guntale {place}",
        ],
    },
    "garbage": {
        "base": 0, "accumulates": True,
        "sizes": [("", 0), ("huge ", 1), ("big ", 0), ("small ", -1)],
        "core": [
            "garbage not collected", "garbage has not been collected",
            "{a}{size}heap of garbage on the roadside", "the dustbin is overflowing",
            "overflowing garbage bin", "people are throwing waste on the road",
            "{a}{size}pile of garbage at the corner", "the garbage van is not coming",
            "trash and plastic dumped everywhere", "construction debris dumped on the road",
            "rotting waste lying on the road", "garbage is being burnt in the open",
            "the community bin is full and waste is lying on the road",
            "no garbage collection in our street", "open dumping of household waste",
            "kachra not cleared from the road",
        ],
        "effects": [
            ("the smell is unbearable", 0), ("mosquitoes and flies are everywhere", 1),
            ("stray dogs are spreading it on the road", 0),
            ("people are burning it and the smoke is unbearable", 1),
            ("it is blocking half of the footpath", 0), ("children play nearby and may fall sick", 1),
            ("rats have increased in the area", 1), ("cows are eating the plastic", 0),
            ("it is a health hazard for the residents", 1),
            ("the drain is getting blocked because of the waste", 0),
        ],
        "hi": [
            "{place} kachra pada hai {dur}", "{dur} kachra nahi uthaya gaya {place}",
            "{place} kooda ka dher laga hai, badbu aa rahi hai", "kachra gaadi nahi aa rahi {dur}",
            "{place} log kachra phenk rahe hain, safai nahi hoti",
        ],
        "te": [
            "{place} chetta teeyatledu {dur}", "{place} chetta kuppa undi, chala vasana vastundi",
            "{dur} chetta bandi raavatledu {place}", "{place} chetta antha roddu meeda padi undi",
        ],
    },
    "drainage": {
        "base": 1, "accumulates": True,
        "sizes": [("", 0), ("severe ", 1), ("knee deep ", 1), ("heavy ", 1), ("minor ", -1)],
        "core": [
            "the drain is overflowing", "drainage overflowing on the road",
            "sewage water flowing on the road", "{size}waterlogging after every rain",
            "the nala is blocked and dirty water is stagnant", "the open drain is choked with plastic",
            "the drain has been blocked", "road flooded with drain water", "the sewage line is blocked",
            "dirty water stagnant in front of the houses", "the storm water drain is clogged",
            "underground drainage is overflowing through the manhole", "the gutter is overflowing",
            "{size}water logging on the road after the rain", "drain water entering the lane",
        ],
        "effects": [
            ("dirty water is entering the houses", 1), ("mosquito breeding has increased", 1),
            ("dengue cases have been reported in the colony", 2),
            ("the road gets flooded after every rain", 0), ("people cannot walk on the road", 0),
            ("the sewage smell is everywhere", 0), ("vehicles are getting stuck in the water", 0),
            ("children have to walk through dirty water to reach school", 1),
            ("the basement of our apartment is flooded", 1), ("there is a risk of disease spreading", 1),
        ],
        "hi": [
            "{place} nala overflow ho raha hai", "{place} gutter ka ganda paani road pe beh raha hai {dur}",
            "baarish ke baad {place} paani bhar gaya hai", "{place} naali band hai, machhar bahut ho gaye hain",
            "{dur} drainage ka paani gharon mein aa raha hai {place}",
        ],
        "te": [
            "{place} drainage overflow avutundi", "{place} murugu neeru roddu meeda paruthundi {dur}",
            "varsham taruvata {place} neellu nilichipoyayi", "{place} kaluva block ayyindi, domalu chala ekkuva",
        ],
    },
    "streetlight": {
        "base": 0, "accumulates": False,
        "sizes": [("", 0)],
        "core": [
            "streetlight not working", "the street lights are not working", "the street light is off",
            "the light on pole number {n} is not working", "the street lights are flickering",
            "all the lights on this road are off", "no street lights in our lane",
            "the street lamp is broken", "the light pole is damaged", "bulb fused in the street light",
            "the electric pole is leaning dangerously", "a live wire is hanging from the electric pole",
            "the transformer is sparking", "a power cable is lying on the road",
            "lights are on during the day and off at night", "current pole light not working",
        ],
        "effects": [
            ("the street is completely dark at night", 1), ("women feel unsafe walking home in the dark", 1),
            ("a chain snatching happened last week", 1), ("there is a risk of electrocution", 2),
            ("accidents can happen in the dark", 1), ("people are slipping in the dark", 0),
            ("thieves are taking advantage of the darkness", 1),
            ("children come back from tuition late in the evening", 1), ("it is a waste of electricity", 0),
        ],
        "hazard_cores": {"the electric pole is leaning dangerously": 2,
                         "a live wire is hanging from the electric pole": 3,
                         "the transformer is sparking": 3, "a power cable is lying on the road": 2},
        "hi": [
            "{place} street light kaam nahi kar rahi", "{dur} {place} light band hai, raat ko andhera rehta hai",
            "{place} bijli ka khamba toota hai aur taar latak raha hai", "{place} street light nahi jal rahi {dur}",
            "{place} batti kharab hai, raat ko darr lagta hai",
        ],
        "te": [
            "{place} street light velagatledu", "{dur} {place} lights levu, raatri antha cheekati",
            "{place} current pole virigipoyindi, wire kinda padi undi", "{place} street light pani cheyyatledu {dur}",
        ],
    },
    "water_leak": {
        "base": 1, "accumulates": True,
        "sizes": [("", 0), ("major ", 1), ("small ", -1), ("huge ", 1)],
        "core": [
            "the water pipeline is leaking", "drinking water pipe burst", "{a}{size}water leakage from the main pipeline",
            "the municipal tap is leaking", "a valve is leaking continuously",
            "water is gushing out from a broken pipe", "pipeline burst on the road",
            "water wastage due to {a}{size}leakage", "no water supply", "low water pressure in our area",
            "dirty water coming from the taps", "contaminated drinking water supply",
            "the water supply line is broken", "underground pipe leaking and water flowing on the road",
            "{a}{size}leak in the water line near the valve",
        ],
        "effects": [
            ("a lot of drinking water is being wasted", 0),
            ("the road is getting damaged because of the leak", 0),
            ("we are not getting water in our homes", 1), ("sewage is mixing with the drinking water", 2),
            ("people are falling sick", 1), ("the leak has made the road slippery", 1),
            ("residents are buying tanker water", 0), ("it is flooding the lane", 0),
        ],
        "hi": [
            "{place} paani ki pipeline phat gayi hai", "{dur} {place} pipe se paani leak ho raha hai",
            "{place} nal se paani beh raha hai, bahut paani barbaad ho raha hai",
            "{dur} paani nahi aa raha {place}", "{place} ganda paani aa raha hai nal mein",
        ],
        "te": [
            "{place} water pipeline pagilindi", "{dur} {place} pipe nunchi neeru leak avutundi",
            "{dur} neellu raavatledu {place}", "{place} kulai nunchi neeru vruthaga potundi",
        ],
    },
    "open_manhole": {
        "base": 2, "accumulates": False,
        "sizes": [("", 0)],
        "core": [
            "the manhole is open", "open manhole on the road", "the manhole cover is missing",
            "manhole without lid", "the manhole lid is broken", "uncovered manhole in the middle of the road",
            "drain cover missing", "the manhole cover has sunk and the hole is open",
            "open sewer chamber on the footpath", "the drain slab is broken and the hole is open",
            "the manhole cover was removed and not replaced", "the manhole is left open after cleaning",
        ],
        "effects": [
            ("someone can fall in at night", 1), ("a child almost fell into it yesterday", 1),
            ("a scooter rider fell into it", 2), ("it is very dangerous for pedestrians", 1),
            ("a cow fell into it last week", 1), ("it is not visible when it rains", 1),
            ("sewage is overflowing from it", 0), ("old people walk here every morning", 1),
        ],
        "hi": [
            "{place} manhole khula pada hai", "{place} manhole ka dhakkan nahi hai {dur}",
            "{place} gutter ka dhakkan toota hua hai, koi bhi gir sakta hai",
            "{dur} {place} khula manhole hai, bahut khatarnak hai",
        ],
        "te": [
            "{place} manhole moota ledu", "{place} manhole terichi undi {dur}",
            "{place} manhole open ga undi, chala pramadakaram",
        ],
    },
    "road_crack": {
        "base": 0, "accumulates": False,
        "sizes": [("", 0), ("long ", 0), ("wide ", 1), ("small ", -1), ("deep ", 1), ("hairline ", -1)],
        "core": [
            "cracks on the road", "{a}{size}crack across the road", "the road surface is damaged",
            "the road is badly damaged", "broken asphalt on the road", "uneven road surface",
            "the tar layer is peeling off", "the road is cracked and sinking",
            "the newly laid road already has cracks", "the road has developed {size}cracks",
            "damaged road near the culvert", "the concrete road has split",
            "the bitumen layer has worn out", "the road surface is breaking into pieces",
        ],
        "effects": [
            ("bikes lose balance on the uneven surface", 1), ("the cracks are widening day by day", 0),
            ("water seeps in and the road is sinking", 1), ("vehicle tyres are getting damaged", 0),
            ("it may turn into a pothole soon", 0), ("ambulances have to slow down here", 1),
            ("pedestrians trip on the broken edges", 1),
        ],
        "hi": [
            "{place} sadak mein daraar aa gayi hai", "{place} road bahut kharab ho gayi hai, jagah jagah daraarein hain",
            "nayi sadak {dur} mein hi toot gayi {place}", "{place} road ki upar ki layer nikal gayi hai",
        ],
        "te": [
            "{place} roddu meeda pagullu vachayi", "{place} kotha road {dur} lone paadaipoyindi",
            "{place} road antha beetalu, bikes jaaripotunnayi",
        ],
    },
    "fallen_tree": {
        "base": 1, "accumulates": False,
        "sizes": [("", 0), ("huge ", 1), ("big ", 0), ("old ", 0), ("small ", -1)],
        "core": [
            "a tree has fallen on the road", "{a}{size}tree fell on the road", "uprooted tree blocking the road",
            "{a}{size}branch broke and is hanging dangerously", "tree branches fell on the road after the storm",
            "fallen tree lying across the lane", "{a}{size}tree collapsed due to heavy rain",
            "the tree is leaning and may fall anytime", "a dry tree is about to fall",
            "fallen branches blocking the footpath", "a tree fell on the electric wires",
            "the tree roots have broken and the tree is tilting",
        ],
        "effects": [
            ("it is blocking the entire road", 1), ("it fell on a parked car", 1),
            ("the branches are touching the electric wires", 2), ("traffic has been diverted", 0),
            ("it may fall on the houses anytime", 1), ("a person got injured", 2),
            ("it damaged our compound wall", 0), ("two wheelers cannot pass", 0),
            ("school buses cannot pass through", 1),
        ],
        "hazard_cores": {"a tree fell on the electric wires": 3},
        "hi": [
            "{place} ped gir gaya hai", "{place} bada ped sadak pe gira hai, rasta band hai",
            "aandhi mein {place} ped ki daali toot gayi", "{place} ped bijli ke taar pe gira hai",
            "{place} sukha ped kabhi bhi gir sakta hai",
        ],
        "te": [
            "{place} chettu padipoyindi", "{place} pedda chettu roddu meeda padindi, road block ayyindi",
            "gaali valla {place} chettu kommalu virigipoyayi", "{place} chettu current wires meeda padindi",
        ],
    },
    "other": {
        "base": 0, "accumulates": False,
        "sizes": [("", 0)],
        # (issue phrase, consequences specific to that issue)
        "core": [
            ("stray dogs menace in our colony", [("a child was bitten last week", 2), ("they chase two wheelers at night", 1)]),
            ("a pack of stray dogs is chasing people", [("children are scared to go out", 1), ("an elderly man was bitten", 2)]),
            ("stray dog bite incidents are increasing", [("people are afraid to walk at night", 1)]),
            ("loud music from the function hall till midnight", [("students cannot study", 0), ("senior citizens cannot sleep", 0)]),
            ("noise pollution from the construction site at night", [("nobody can sleep", 0)]),
            ("loudspeakers playing very loud late at night", [("it has become a daily nuisance", 0)]),
            ("illegal parking is blocking the lane", [("ambulances cannot enter", 1), ("residents cannot take out their vehicles", 0)]),
            ("cars are parked on both sides blocking the road", [("there is a traffic jam every evening", 0)]),
            ("vendors have encroached the footpath", [("pedestrians are forced to walk on the road", 1)]),
            ("shop owners have encroached the footpath with their goods", [("people cannot walk freely", 0)]),
            ("illegal construction on government land", [("it is blocking the public lane", 0)]),
            ("the bench in the park is broken", [("elderly people have nowhere to sit", 0)]),
            ("the swings in the children's park are broken", [("a child got hurt yesterday", 1)]),
            ("the park is not maintained and the grass is overgrown", [("snakes have been seen", 1)]),
            ("illegal hoardings are blocking the view at the junction", [("drivers cannot see oncoming traffic", 1)]),
            ("an abandoned vehicle has been lying on the road for months", [("it has become a parking nuisance", 0)]),
            ("cattle are roaming on the main road", [("they cause traffic jams", 0), ("a bike hit a cow last week", 1)]),
            ("monkey menace in the colony", [("they snatch food from children", 1)]),
            ("the public toilet is locked and not maintained", [("people are forced to go in the open", 0)]),
            ("mosquito fogging has not been done in our area", [("many people have fever", 1)]),
            ("wall posters and graffiti on the newly painted wall", [("it looks very ugly", 0)]),
            ("the street name board is missing", [("visitors and delivery people get lost", 0)]),
            ("the bus shelter is damaged", [("passengers stand in the sun", 0)]),
            ("pigs roaming in the residential area", [("it is unhygienic", 0)]),
            ("an unauthorised shed has been built on the footpath", [("pedestrians walk on the road", 1)]),
            ("hawkers are blocking the bus stop", [("passengers cannot board the bus", 0)]),
            ("the open gym equipment in the park is broken", [("someone may get hurt", 1)]),
            ("drunkards are creating nuisance near the park at night", [("women feel unsafe", 1)]),
            ("the lake is being encroached by builders", [("the lake is shrinking every year", 0)]),
            ("an old building is in dangerous condition", [("it may collapse anytime", 2)]),
        ],
        "effects": [],
        "hi": [
            "{place} awara kutte bahut hain, bacchon ko kaat rahe hain",
            "{place} raat ko bahut shor hota hai loudspeaker ka",
            "{place} gaadiyan galat parking karte hain, rasta band ho jata hai",
            "{place} footpath pe dukaanon ne kabza kar liya hai", "{place} park ki bench tooti hui hai",
            "{place} bandar bahut pareshan kar rahe hain", "{place} gaay aur bhains sadak pe ghoomti rehti hain",
        ],
        "te": [
            "{place} kukkalu chala ekkuva, pillalani karustunnayi",
            "{place} raatri chala sound tho music pedutunnaru",
            "{place} illegal parking valla road block avutundi", "{place} footpath meeda shops pettaru",
            "{place} kothulu chala ibbandi pedutunnayi",
        ],
    },
}
# Hazard cues inside the romanised templates (substring -> severity delta; the largest applies).
HI_TE_HAZARD_WORDS = (
    ("accident", 1), ("khatarnak", 1), ("pramadakaram", 1), ("gir sakta", 1), ("taar", 2),
    ("wire", 2), ("current wires", 2), ("kaat", 1), ("karustunnayi", 1), ("bikes padipotunnayi", 1),
    ("gharon mein", 1), ("machhar", 1), ("domalu", 1), ("ganda paani aa raha", 1), ("bike gir", 1),
)

TYPOS = {
    "garbage": ["garbge", "garbag", "garabage"], "pothole": ["pothol", "pothhole", "photole"],
    "potholes": ["potholse", "potholes"], "drainage": ["drainege", "drainag"],
    "street": ["steet", "streat"], "light": ["lite", "ligth"], "lights": ["lites", "ligths"],
    "manhole": ["manhol", "man hole"], "please": ["pls", "plz", "plese"], "water": ["watr", "wter"],
    "leakage": ["leakege", "lekage"], "accident": ["acident", "accidnt"], "hospital": ["hospitl", "hosptal"],
    "mosquitoes": ["mosquitos", "mosqitoes"], "electric": ["electrc", "eletric"], "pipeline": ["pipline", "pipe line"],
    "overflowing": ["overflowng", "over flowing"], "collected": ["colected", "collectd"],
    "dangerous": ["dangerus", "dangerous"], "children": ["childern", "chidren"], "school": ["scool", "skool"],
    "working": ["wrking", "workin"], "blocked": ["blokced", "blocked"], "traffic": ["trafic", "traffc"],
}


# ------------------------------------------------------------------------------------------------
# Feedback corpus (hand-curated).
# ------------------------------------------------------------------------------------------------
FEEDBACK = {
    "positive": [
        "The issue was resolved quickly. Thank you!", "Very happy with the quick response from the municipal team.",
        "The pothole was filled within two days. Great work.", "Excellent service, the officer kept me updated at every step.",
        "Garbage was cleared the same day. Really impressed.", "Thanks to the team, the streetlight is working now.",
        "Good job, the drain was cleaned properly.", "Prompt action by the department, I really appreciate it.",
        "The water leakage was fixed and the road is dry now. Thanks.", "Satisfied with the work done.",
        "Quick and professional work by the field officer.", "Problem solved, keep it up!",
        "Bahut accha kaam kiya, thank you.", "Chala bagundi, tondaraga fix chesaru. Thanks.",
        "Superb response, the fallen tree was removed within hours.", "Finally fixed! Thank you for the follow up.",
        "Not bad at all, they fixed it in a day.", "It took a few days but the quality of work is excellent.",
        "I was doubtful at first but the team did a wonderful job.", "The officer was polite and very helpful.",
        "Everything looks good now, much better than before.", "The road is smooth now, great effort by the roads department.",
        "Thanks a lot, the manhole has been covered safely.", "Very efficient, I will recommend this app to my neighbours.",
        "Impressed by how fast it was resolved!!", "Great work 👍",
        "Shukriya, ab light theek se jal rahi hai.", "Dhanyavaad, kaam badhiya hua.",
        "Work completed neatly, appreciate the effort.", "Resolved on time, thank you.",
        "The new pipeline works perfectly, no more leakage.", "Wonderful experience, the complaint was handled smoothly.",
        "Happy to see the garbage point cleaned and painted.", "The team responded within 24 hours. Excellent.",
        "Good service, the street is bright again at night.", "Kudos to the drainage team for clearing the blockage.",
        "I am satisfied, the officer explained everything clearly.", "Fast response and neat work. Thank you so much.",
        "The crack has been repaired properly, the road feels safe now.", "Really grateful for the quick action near the school.",
        "Manchi pani chesaru, thank you sir.", "The problem is completely fixed. Great job!",
        "Very responsive team, issue sorted in one visit.", "Thank you for removing the tree branches so quickly.",
        "Good work by the electrical department, the pole is safe now.", "Appreciate the transparency, I could track every update.",
        "Awesome! The water supply is back to normal.", "Bahut badhiya, ek din mein kaam ho gaya.",
        "Neat and clean now, thanks to the sanitation workers.", "The officer was helpful and the repair was quick.",
        "Well done team, the drain is flowing freely now.", "Excellent coordination between departments, issue resolved.",
        "I didn't expect such a quick fix, thank you!", "No complaints, the work was done well.",
        "Super fast service, impressed with CivicAI.", "Chala thanks, ippudu road bagundi.",
        "The streetlights are working perfectly now. Happy.", "Good response, the manhole cover was replaced the same evening.",
        "Really pleased with the outcome.", "Very nice work, the area looks much cleaner.",
        "Thank you, the leak is fixed and the water pressure is good.", "Professional and courteous staff, great experience.",
        "Amazing turnaround, the potholes are gone.", "The whole lane is clean now, thanks a ton 🙏",
    ],
    "neutral": [
        "The officer visited the site today.", "Work started this morning.", "Received the update about the complaint.",
        "The complaint status shows resolved.", "They came and checked the drain.", "Repair work was done yesterday.",
        "The pipeline was replaced by the contractor.", "Okay.", "Noted.", "Work is in progress as per the officer.",
        "The garbage truck came at 9 am.", "The streetlight was repaired on Tuesday.",
        "Someone from the department called me.", "Average work, nothing special.",
        "It is fine for now, will check again after the rain.", "Theek hai.",
        "The tree was cut and moved to the side of the road.", "The team inspected the manhole and took photos.",
        "They said the road will be relaid next month.", "Complaint closed after the site visit.",
        "The officer asked for more details.", "Water supply timings are the same as before.",
        "The work was done at night.", "A new bulb was fitted in the pole.", "Received a call from the ward office.",
        "The pothole was filled with gravel for now.", "The contractor will come again on Monday.",
        "Status updated to in progress.", "Officer said the drain will be cleaned this week.",
        "The area was measured for repair.", "Pani supply normal hai ab.", "Officer vachi chusaru.",
        "The cover was placed on the manhole.", "They removed the garbage and left.",
        "The complaint was forwarded to the electrical department.", "It is okay, the work is done.",
        "The road was patched with cement.", "The officer came with two workers.", "Got the SMS about the resolution.",
        "No further comments.", "The work was completed as per schedule.", "They will monitor the leak for a few days.",
        "The branch was cut and taken away by the truck.", "Work done as per the complaint.",
        "The supervisor checked the work.", "The issue was looked into by the ward engineer.", "Kaam ho gaya.",
        "Officer phone chesaru, repair schedule chepparu.", "The dustbin was shifted to the corner of the lane.",
        "Site inspection completed on Friday.", "The JCB came in the afternoon.",
        "They asked me to send one more photo.",
    ],
    "negative": [
        "Still not fixed after 3 weeks, useless.", "No action taken, total waste of time.",
        "The pothole is still there, they just marked it resolved.", "Very poor work, the patch has already broken.",
        "Nobody came to inspect, very disappointed.", "Worst service, the garbage is piling up again.",
        "They closed the complaint without fixing anything.", "The drain overflowed again the next day.",
        "Pathetic response from the department.", "The officer was rude and did not listen.",
        "Temporary fix only, the leak started again.", "Not satisfied with the work.",
        "Bilkul bekar kaam, kuch nahi hua.", "Inka fix cheyaledu, waste.", "Took 2 months to respond, too slow.",
        "Fake resolution photo, the problem still exists.", "They resolved it quickly but it broke again within a week.",
        "Disgusting, the smell is still unbearable.", "I am not happy with how this was handled.",
        "Half done work, the road is still uneven.", "The streetlight works for one day and then goes off again.",
        "Nobody cares about our colony.", "The garbage was not cleared at all.",
        "Very bad experience, I had to call five times.", "The manhole is still open, someone will fall in.",
        "Useless app, nothing happens after complaining.", "The water is still leaking from the same pipe.",
        "Ghatiya kaam, gaddha phir se ho gaya.", "Officer never visited, the complaint was closed without any work.",
        "Too late, the tree had already damaged our wall.", "The repair quality is very poor.",
        "Frustrated with the delay.", "Same problem again, waste of money.",
        "They just dumped mud in the pothole, it is worse now.", "No one responded to my calls.",
        "Completely unsatisfied, the issue is not resolved.", "Bakwas service, koi sunta nahi.",
        "The cleaning was done badly and the waste is back.", "Pani abhi bhi nahi aa raha, bahut pareshani hai.",
        "Chala late ga vacharu, pani kuda sariga cheyaledu.", "The drain is still blocked after the so-called cleaning.",
        "Irresponsible staff, very unhappy.", "Hopeless, the light is still not working.",
        "They broke the footpath while fixing the pipe and left it.", "I am disappointed, the complaint was ignored for weeks.",
        "Poor coordination, each department blames the other.", "The work stopped halfway.",
        "It is dangerous, the wires are still hanging.", "Worst experience ever 😡", "Not resolved at all, please reopen.",
        "The quality is terrible, cracks appeared again in two days.", "Waste of time, the same pothole is back after the rain.",
        "They did not even inspect the site.", "Very slow response, the smell is unbearable.",
        "Complaint closed without my confirmation, not acceptable.", "Unhappy with the officer's attitude.",
        "The issue keeps coming back, no permanent solution.", "Kuch nahi kiya, sirf photo khinch ke chale gaye.",
        "Nothing has changed, the garbage is still on the road.", "The tree branches are still lying on the road.",
        "Very disappointing service.", "Evaru raaledu, chala worst service.",
    ],
}


# ------------------------------------------------------------------------------------------------
# Hand-written challenge set (never used for training).
# ------------------------------------------------------------------------------------------------
CHALLENGE = {
    "pothole": [
        "Two-wheeler riders are falling into the crater outside Sri Sai temple every night, it is at least a foot deep.",
        "The road outside the supermarket has caved in, there is a hole big enough to swallow a scooter wheel.",
        "Bhaiya yahan road mein itna bada gadda hai ki auto palat sakta hai",
        "potholes on the flyover ramp, cars braking suddenly",
        "After the cable laying work they left the road with deep pits, nobody filled them.",
        "Huge potholes on the stretch from the bus depot to the market, my back hurts every ride.",
        "Rain water hides the potholes so you cannot tell how deep they are.",
        "Gunta lo bike padipoyindi, road meeda chala pedda guntalu unnayi",
        "Hole in the middle of the lane, the size of a tyre, right where kids play cricket.",
        "Please patch the craters near the hospital gate, ambulances are struggling.",
    ],
    "garbage": [
        "Nobody has picked up the waste from our street for nine days, bags are piling up.",
        "The corner near the bakery has become a dumping yard for plastic and food waste.",
        "Kachra wale bhaiya aaye hi nahi is hafte",
        "Someone set fire to the rubbish heap behind the school, the smoke is choking.",
        "The municipal bin is overflowing and crows are scattering everything.",
        "The wedding hall throws leftover food on the road every night, it rots and stinks.",
        "chetta veyadaniki bin ledu, andaru road meede padestunnaru",
        "Construction waste and broken tiles dumped on the footpath by the builder.",
        "Door to door collection has stopped in our apartment block.",
        "Plastic covers and bottles all over the lake bund, please clean.",
    ],
    "drainage": [
        "Every time it rains our street turns into a river, the stormwater drain is choked.",
        "Black sewage water is bubbling up and spreading across the lane.",
        "Nali jam ho gayi hai, ganda paani ghar ke andar aa raha hai",
        "The open nala behind the colony is full of silt and stinks terribly.",
        "Ankle deep water outside the metro station after a 10 minute shower.",
        "The underground drainage pipe is blocked, toilets are backing up in five houses.",
        "Varsham padite maa veedhi motham neellu, kaluva clean cheyyaledu",
        "Stagnant drain water has turned green and is breeding mosquitoes.",
        "The culvert under the road is clogged with plastic so water floods the junction.",
        "Sewer overflowing near the vegetable market, people walk through filth.",
    ],
    "streetlight": [
        "The whole stretch from the bus stop to our colony is pitch dark after 7 pm.",
        "Lamp post number 23 has been blinking on and off for days.",
        "Raat ko gali mein ek bhi batti nahi jalti, bahut darr lagta hai",
        "An electric wire snapped and is dangling low near the tea stall, it is live.",
        "The light outside the girls hostel is dead, women are scared to walk back.",
        "Sparks flying from the junction box on the pole whenever it rains.",
        "Street lamps stay on all day and are off at night, someone fix the timer.",
        "Maa road lo street lights anni off, cheekati lo accidents avutunnayi",
        "The bulb in the pole opposite the ATM got fused last week.",
        "The transformer near the park is humming loudly and smoking.",
    ],
    "water_leak": [
        "Clean drinking water has been gushing from a cracked main for two days.",
        "A joint in the supply line under the road is spraying water onto passing bikes.",
        "Nal se 24 ghante paani tapak raha hai, koi plumber nahi aaya",
        "We get yellowish smelly water from the municipal connection.",
        "No supply since Sunday, the tanker also did not come.",
        "The valve chamber near the school is leaking and the road is always wet.",
        "Neellu motham vruthaga potunnayi, pipe pagilipoyindi",
        "Pressure is so low that water does not reach the first floor.",
        "A broken pipeline has formed a small pond on the main road.",
        "Leak in the overhead tank outlet, thousands of litres wasted every day.",
    ],
    "open_manhole": [
        "Somebody stole the iron lid of the manhole and now it is a gaping hole on the road.",
        "The sewer hole outside the school is uncovered, a kid nearly fell in.",
        "Manhole ka dhakkan gayab hai, raat ko dikhai bhi nahi deta",
        "Workers opened the chamber for cleaning and left without closing it.",
        "The concrete slab over the drain cracked and collapsed leaving an open pit.",
        "Uncovered sewage chamber in the middle of the market lane.",
        "Manhole meeda moota ledu, pillalu aadukune chota",
        "The manhole cover is broken in half and the hole is exposed.",
        "A cow got stuck in the open manhole near the temple.",
        "Missing drain cover near the bus stop, pedestrians step in at night.",
    ],
    "road_crack": [
        "The new cement road has developed long cracks within three months.",
        "Asphalt is peeling off in layers on the main road, gravel everywhere.",
        "Sadak ki surface jagah jagah se tooti hai aur daraarein badh rahi hain",
        "The road near the bridge has sunk unevenly, vehicles jump.",
        "Fine cracks spreading across the junction after the heavy trucks.",
        "The road is broken at the edges and crumbling into the drain.",
        "Kotha road lo appude pagullu vachayi",
        "The tar surface is uneven and wavy, bikes skid.",
        "Large fissures across the lane, water seeps in when it rains.",
        "Damaged road surface outside the warehouse, it is like a washboard.",
    ],
    "fallen_tree": [
        "A gulmohar tree came down in the storm last night and is lying across the road.",
        "A huge branch is hanging by a thread over the bus stop.",
        "Aandhi mein neem ka ped ukhad gaya, rasta poora band",
        "A tree fell on the boundary wall of the school and broke it.",
        "An uprooted tree is resting on the power lines, it could snap anytime.",
        "Dead tree leaning towards the houses, the trunk is hollow.",
        "Pedda chettu gaali ki virigi road meeda paddadi",
        "Broken branches blocking the entrance of our lane since the cyclone.",
        "A tree collapsed onto two parked cars outside the hospital.",
        "Branches have broken and fallen onto the footpath, people walk on the road.",
    ],
    "other": [
        "A pack of street dogs bit a delivery boy near the park last night.",
        "DJ music from the marriage hall goes on past midnight every weekend.",
        "Trucks are parked permanently on the colony road, we cannot get our cars out.",
        "Vendors have taken over the entire footpath with their carts.",
        "Cattle sit in the middle of the main road causing jams.",
        "The slide in the children's park has a broken step.",
        "Someone is constructing a shed on the public footpath without permission.",
        "Monkeys are entering houses and snatching food from kids.",
        "A huge illegal hoarding at the junction is tilting dangerously.",
        "The public toilet near the bus stand has no water and is locked.",
    ],
}


# ------------------------------------------------------------------------------------------------
# Held-out feedback challenge set (never used to tune the sentiment lexicon).
# ------------------------------------------------------------------------------------------------
FEEDBACK_CHALLENGE = {
    "positive": [
        "Superb effort by the ward staff, the lane finally looks decent.",
        "Thank you ward team for the swift repair of our street light.",
        "Road relaid within a week, really happy with the quality.",
        "Credit to the engineer who personally supervised the work.",
        "Hats off to the sanitation crew, spotless now.",
        "Earlier it took months, this time just two days. Great improvement.",
        "We can finally walk safely at night, thanks a lot.",
        "The response was faster than I expected. Very satisfied.",
        "Very good coordination, they even called to confirm.",
        "No more flooding in our street, wonderful job.",
        "Bahut shukriya, ab sadak bilkul theek hai.",
        "Nice to see such quick action, keep up the good work.",
        "The officer was very cooperative and solved it the same day.",
        "Pleasantly surprised by the fast service.",
        "Clean and tidy now, appreciate everyone involved.",
        "Chala thanks andi, drainage clean ga undi ippudu.",
        "Brilliant, the manhole was sealed within hours of reporting.",
        "Glad the dangerous branch was removed before anyone got hurt.",
        "Good to see the system actually works!",
        "The water supply is regular now, thank you very much.",
    ],
    "neutral": [
        "The officer came on Wednesday and noted the details.",
        "Work order was issued, waiting for the contractor.",
        "They replaced the bulb in the morning.",
        "A team member visited and measured the pothole.",
        "I got a message that the complaint was assigned.",
        "The status changed to resolved today.",
        "The tanker came at 6 pm.",
        "Municipal staff collected the garbage in the evening.",
        "The site engineer will inspect again next week.",
        "Road work has started near the junction.",
        "They cut the branches and stacked them on the side.",
        "The complaint number was shared over SMS.",
        "Officer informed that material is on order.",
        "The drain was cleaned on Saturday.",
        "Someone came and took photographs of the area.",
        "Kal team aayi thi, naap le ke gayi.",
        "Repair cheyyadaniki team vachindi.",
        "The light pole was painted and numbered.",
        "Pipe replacement is scheduled for Monday.",
        "Okay, noted the update.",
    ],
    "negative": [
        "Three weeks and nobody has turned up, this is ridiculous.",
        "The so-called repair washed away in the first rain.",
        "They filled the pothole with loose soil, now it is muddy and worse.",
        "Marked as resolved but the light is still dead.",
        "Garbage collection stopped again after two days.",
        "I am tired of calling the helpline, no one picks up.",
        "Shoddy work, the cover is already loose.",
        "Officials are least bothered about our area.",
        "Complaint closed without any visit, very poor.",
        "The leak is worse than before after their repair.",
        "Kya faltu system hai, koi kaam nahi hota.",
        "Inka drainage overflow avutundi, emi cheyaledu.",
        "Absolutely disappointed with the response time.",
        "The workers left the debris on the road, now it is a bigger problem.",
        "Sewage is still entering our homes, nobody cares.",
        "Took a month just to send someone, unacceptable.",
        "Every promise was broken, nothing improved.",
        "The patch has already cracked, money wasted.",
        "They came, looked and left without doing anything.",
        "Disgusted with the attitude of the staff.",
    ],
}


# ------------------------------------------------------------------------------------------------
# Generation
# ------------------------------------------------------------------------------------------------
def _pick_language(rng):
    roll, acc = rng.random(), 0.0
    for lang, weight in LANGUAGE_WEIGHTS:
        acc += weight
        if roll < acc:
            return lang
    return "en"


def _sentence_case(text):
    text = " ".join(text.split())
    return text[:1].upper() + text[1:] if text else text


def _apply_typos(rng, text):
    """Replace 1-2 words with a realistic misspelling (dictionary first, else a character slip)."""
    words = text.split(" ")
    candidates = [i for i, w in enumerate(words) if len(w.strip(".,!?")) >= 5]
    rng.shuffle(candidates)
    for i in candidates[: rng.choice((1, 1, 2))]:
        word = words[i]
        core = word.strip(".,!?")
        tail = word[len(core):]
        lower = core.lower()
        if lower in TYPOS:
            replacement = rng.choice(TYPOS[lower])
        else:
            pos = rng.randrange(1, len(core) - 1)
            op = rng.choice(("drop", "swap", "double"))
            if op == "drop":
                replacement = core[:pos] + core[pos + 1:]
            elif op == "swap":
                replacement = core[:pos] + core[pos + 1] + core[pos] + core[pos + 2:]
            else:
                replacement = core[:pos] + core[pos] + core[pos:]
        words[i] = replacement + tail
    return " ".join(words)


def _fill(template, rng, *, size="", place="", dur=""):
    article = "a " if "{a}" in template else ""
    text = template.replace("{a}", article).replace("{size}", size)
    text = text.replace("{place}", place).replace("{dur}", dur).replace("{n}", str(rng.randint(3, 140)))
    return " ".join(text.split())


def _english_row(rng, spec):
    """Compose one Indian-English complaint and its severity index."""
    severity = spec["base"]
    entry = rng.choice(spec["core"])
    core, effects = (entry if isinstance(entry, tuple) else (entry, spec["effects"]))
    size, size_delta = rng.choice(spec["sizes"]) if "{size}" in core else ("", 0)
    severity += size_delta
    severity = max(severity, spec.get("hazard_cores", {}).get(core, 0))
    place, sensitivity = rng.choice(PLACES_EN) if rng.random() < 0.75 else ("", 0)
    dur, days = rng.choice(DURATIONS_EN) if rng.random() < 0.45 else ("", 0)
    issue = _fill(core, rng, size=size)

    style = rng.random()
    if style < 0.25:  # texting-style fragment: "big pothole near bus stop"
        text = " ".join(p for p in (issue, place.replace("the ", "", 1), dur if rng.random() < 0.3 else "") if p)
        effect_delta = 0
        text = text.lower()
    else:
        first = " ".join(p for p in ((issue, place, dur) if rng.random() < 0.6 else (issue, dur, place)) if p)
        sentences = [_sentence_case(first) + "."]
        effect_delta = 0
        if effects and rng.random() < 0.6:
            effect, effect_delta = rng.choice(effects)
            if rng.random() < 0.4:
                sentences[0] = sentences[0][:-1] + " and " + effect + "."
            else:
                sentences.append(_sentence_case(effect) + ".")
        if rng.random() < 0.45:
            sentences.append(rng.choice(REQUESTS_EN))
        opener = rng.choice(OPENERS_EN) if rng.random() < 0.3 else ""
        if opener:
            sentences[0] = opener + sentences[0][0].lower() + sentences[0][1:]
        text = " ".join(sentences)
        if style > 0.95:
            text = text.upper()
    severity += max(effect_delta, 0)
    if sensitivity == 2:
        severity += 1
    if (days >= 14 and spec["accumulates"]) or days >= 60:
        severity += 1
    return text, severity


def _romanised_row(rng, spec, lang):
    """Compose one Hinglish (lang="hi") or romanised Telugu (lang="te") complaint."""
    places, durations, requests = (
        (PLACES_HI, DURATIONS_HI, REQUESTS_HI) if lang == "hi" else (PLACES_TE, DURATIONS_TE, REQUESTS_TE)
    )
    template = rng.choice(spec[lang])
    place, sensitivity = rng.choice(places) if rng.random() < 0.8 else ("", 0)
    dur, days = rng.choice(durations) if rng.random() < 0.5 else ("", 0)
    text = _fill(template, rng, place=place, dur=dur)
    severity = spec["base"]
    lowered = text.lower()
    severity += max([delta for word, delta in HI_TE_HAZARD_WORDS if word in lowered] or [0])
    if sensitivity == 2:
        severity += 1
    if (days >= 14 and spec["accumulates"]) or days >= 60:
        severity += 1
    if rng.random() < 0.35:
        text = text + ", " + rng.choice(requests)
    if rng.random() < 0.5:
        text = _sentence_case(text)
    return text, severity


def generate_complaints(seed=SEED, rows_per_class=ROWS_PER_CLASS):
    """Return ``[(text, label, severity_level), ...]`` - deterministic for a given seed."""
    rng = random.Random(seed)
    rows, seen = [], set()
    for label, spec in CLASSES.items():
        produced, attempts = 0, 0
        while produced < rows_per_class and attempts < rows_per_class * 50:
            attempts += 1
            lang = _pick_language(rng)
            if lang == "en":
                text, severity = _english_row(rng, spec)
            else:
                text, severity = _romanised_row(rng, spec, lang)
            if rng.random() < 0.15:
                text = _apply_typos(rng, text)
            key = text.lower()
            if key in seen:
                continue
            seen.add(key)
            rows.append((text, label, LEVELS[min(max(severity, 0), 3)]))
            produced += 1
    return rows


def generate_feedback():
    """Return ``[(text, label), ...]`` from the curated feedback lists (stable order)."""
    rows = []
    for label in ("positive", "neutral", "negative"):
        rows.extend((text, label) for text in FEEDBACK[label])
    return rows


def generate_feedback_challenge():
    """Return ``[(text, label), ...]`` from the held-out feedback lists (stable order)."""
    return [(text, label) for label, texts in FEEDBACK_CHALLENGE.items() for text in texts]


def generate_challenge():
    """Return ``[(text, label), ...]`` from the hand-written challenge lists (stable order)."""
    return [(text, label) for label, texts in CHALLENGE.items() for text in texts]


def write_csv(path, header, rows):
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


def main():
    complaints = generate_complaints()
    feedback = generate_feedback()
    write_csv(COMPLAINT_CSV, ("text", "label", "severity"), complaints)
    write_csv(FEEDBACK_CSV, ("text", "label"), feedback)
    challenge = generate_challenge()
    write_csv(CHALLENGE_CSV, ("text", "label"), challenge)
    print(f"Wrote {len(complaints)} complaint rows -> {COMPLAINT_CSV}")
    print(f"Wrote {len(feedback)} feedback rows -> {FEEDBACK_CSV}")
    feedback_challenge = generate_feedback_challenge()
    write_csv(FEEDBACK_CHALLENGE_CSV, ("text", "label"), feedback_challenge)
    print(f"Wrote {len(challenge)} challenge rows -> {CHALLENGE_CSV}")
    print(f"Wrote {len(feedback_challenge)} feedback challenge rows -> {FEEDBACK_CHALLENGE_CSV}")


if __name__ == "__main__":
    main()
