"""Sentiment vocabulary for citizen feedback (used by ``ai.nlp.sentiment``).

Valences follow the VADER convention (roughly -4 .. +4; "good" 1.9, "excellent" 3.2, "bad" -2.5,
"worst" -3.1) and were written for post-resolution civic feedback:

* ``WORD_VALENCE`` - English plus common Hinglish / romanised Telugu sentiment words (accha,
  badhiya, bekar, ghatiya, baagundi, baaledu ...). Completion words ("fixed", "repaired") are only
  mildly positive (+0.6): "The streetlight was repaired on Tuesday" is a factual, neutral update,
  while "fixed quickly, thank you" is positive through its other words.
* ``PHRASE_VALENCE`` - civic phrases matched before single words ("resolved quickly" +2.8,
  "still not fixed" -2.8, "no action" -2.5, "waste of time" -2.8).
* ``BOOSTERS`` - intensifiers (+0.293) and dampeners (-0.293), VADER's scalar.
* ``SERVICE_ACTIONS`` - verbs whose *negation* is a strong complaint ("did not even inspect",
  "nobody responded", "closed without fixing").
* ``PROBLEM_STATES`` - words that, after "still", signal the issue persists ("still leaking").
* ``EMOJI_VALENCE`` - a few emoji common in feedback.
* ``TRANSLATIONS`` - Hinglish / Telugu sentiment words rendered in English for the production
  transformer model, which was trained on English text.
"""

WORD_VALENCE = {
    # --- positive -----------------------------------------------------------------------------
    "good": 1.9, "great": 3.1, "excellent": 3.2, "awesome": 3.1, "amazing": 2.8, "wonderful": 2.7,
    "fantastic": 2.6, "superb": 2.9, "brilliant": 2.8, "outstanding": 3.0, "perfect": 2.7,
    "perfectly": 2.4, "nice": 1.8, "fine": 0.7, "okay": 0.3, "happy": 2.2, "glad": 2.0, "pleased": 2.0,
    "satisfied": 1.9, "satisfactory": 1.5, "satisfying": 1.8, "delighted": 2.8, "impressed": 2.4,
    "impressive": 2.4, "appreciate": 2.1, "appreciated": 2.1, "appreciation": 2.0, "grateful": 2.2,
    "thankful": 2.1, "thanks": 1.9, "thank": 1.6, "thx": 1.5, "helpful": 2.0, "polite": 1.7,
    "courteous": 1.8, "cooperative": 1.6, "responsive": 1.8, "professional": 1.6, "efficient": 2.0,
    "effective": 1.8, "prompt": 1.8, "promptly": 1.8, "quick": 1.4, "quickly": 1.4, "fast": 1.2,
    "speedy": 1.6, "timely": 1.6, "swift": 1.6, "smooth": 1.4, "smoothly": 1.4, "safe": 1.3,
    "safely": 1.3, "safer": 1.4, "better": 1.6, "best": 2.8, "improved": 1.6, "improvement": 1.4,
    "recommend": 1.6, "love": 2.6, "loved": 2.6, "commendable": 2.5, "kudos": 2.4, "bravo": 2.2,
    "relief": 1.6, "relieved": 1.8, "success": 2.0, "successful": 2.0, "neat": 1.4, "neatly": 1.4,
    "clean": 1.2, "cleaner": 1.4, "bright": 1.0, "properly": 1.0, "proper": 0.8, "dedicated": 1.8,
    "hardworking": 1.9, "transparency": 1.2, "transparent": 1.2, "finally": 0.5, "normal": 0.3,
    "solution": 1.2, "solved": 1.2, "well": 1.0, "super": 2.3,
    # completion words: mildly positive (see module docstring)
    "fixed": 0.6, "resolved": 0.6, "repaired": 0.6, "cleaned": 0.6, "cleared": 0.6, "replaced": 0.6,
    "removed": 0.6, "restored": 0.8, "covered": 0.6, "filled": 0.6, "patched": 0.6, "sorted": 0.8,
    "completed": 0.4,
    # --- negative -----------------------------------------------------------------------------
    "bad": -2.5, "poor": -2.1, "worst": -3.1, "terrible": -2.9, "horrible": -2.9, "awful": -2.8,
    "pathetic": -3.0, "useless": -2.6, "worthless": -2.6, "disappointing": -2.3, "disappointed": -2.3,
    "disappointment": -2.3, "unhappy": -2.2, "sad": -2.0, "angry": -2.4, "frustrated": -2.3,
    "frustrating": -2.3, "annoyed": -2.0, "annoying": -2.0, "irritated": -2.0, "upset": -1.9,
    "dissatisfied": -2.3, "unsatisfied": -2.1, "unsatisfactory": -2.1, "careless": -2.0,
    "negligent": -2.3, "negligence": -2.4, "irresponsible": -2.4, "lazy": -2.0, "rude": -2.4,
    "arrogant": -2.3, "corrupt": -2.8, "corruption": -2.8, "bribe": -2.6, "fake": -2.4, "false": -1.6,
    "cheated": -2.4, "ignored": -2.0, "ignore": -1.6, "ignoring": -1.8, "delay": -1.4, "delayed": -1.6,
    "delays": -1.4, "slow": -1.4, "slowly": -1.2, "late": -1.2, "pending": -1.0, "incomplete": -1.6,
    "unfinished": -1.6, "unresolved": -2.0, "worse": -2.3, "waste": -1.8, "wasted": -2.0, "mess": -1.8,
    "messy": -1.6, "dirty": -1.8, "filthy": -2.4, "stinking": -1.8, "unbearable": -2.4,
    "disgusting": -2.8, "dangerous": -1.8, "unsafe": -1.8, "problem": -0.8, "failed": -2.0, "fail": -1.8,
    "failure": -2.0, "nonsense": -2.0, "ridiculous": -2.2, "shameful": -2.5, "shame": -2.2,
    "hopeless": -2.4, "helpless": -1.8, "suffering": -2.0, "suffer": -1.8, "suffered": -1.9,
    "trouble": -1.6, "inconvenience": -1.6, "hate": -2.7, "doubtful": -1.4, "blames": -1.4,
    "blame": -1.4, "halfway": -1.5, "stopped": -0.8, "reopen": -0.8, "badly": -2.0, "again": -0.6,
    "broken": -1.4, "broke": -1.4, "leaking": -1.0, "leakage": -0.8, "overflowing": -1.2,
    "overflowed": -1.2, "flooded": -1.0, "uneven": -0.8, "damaged": -1.2, "blocked": -1.0,
    "stagnant": -1.0,
    # --- Hinglish / romanised Telugu ---------------------------------------------------------------
    "accha": 1.9, "achha": 1.9, "acha": 1.9, "achchha": 1.9, "badhiya": 2.3, "badiya": 2.3,
    "badhia": 2.3, "zabardast": 2.8, "jabardast": 2.8, "shandaar": 2.8, "shandar": 2.8, "mast": 2.0,
    "shukriya": 2.0, "shukria": 2.0, "dhanyavad": 2.0, "dhanyavaad": 2.0, "dhanyawad": 2.0,
    "dhanyavaadalu": 2.0, "baagundi": 2.0, "bagundi": 2.0, "bagunnadi": 2.0, "manchi": 1.9,
    "bekar": -2.4, "bekaar": -2.4, "bakwas": -2.6, "bakwaas": -2.6, "ghatiya": -2.8, "ghatia": -2.8,
    "kharab": -2.0, "kharaab": -2.0, "bura": -2.0, "buri": -2.0, "ganda": -1.8, "gandi": -1.8,
    "faltu": -2.0, "nikamma": -2.5, "nikamme": -2.5, "pareshan": -1.8, "pareshaan": -1.8,
    "pareshani": -1.8, "baaledu": -2.0, "bagaledu": -2.0, "bagoledu": -2.0, "dandaga": -2.2,
}

PHRASE_VALENCE = {
    # positive
    "resolved quickly": 2.8, "fixed quickly": 2.8, "solved quickly": 2.8, "quick response": 2.6,
    "quick action": 2.6, "prompt action": 2.6, "prompt response": 2.6, "fast response": 2.5,
    "timely action": 2.4, "quick fix": 2.2, "on time": 1.6, "in a day": 1.2, "within a day": 1.6,
    "within hours": 1.8, "same day": 1.6, "good job": 2.6, "great job": 3.0, "well done": 2.6,
    "done well": 1.8, "nice work": 2.4, "good work": 2.4, "great work": 3.0, "keep it up": 2.4,
    "thank you": 2.0, "thanks a lot": 2.6, "thanks a ton": 2.6, "problem solved": 2.4,
    "issue resolved": 2.0, "fully resolved": 2.4, "completely fixed": 2.4, "much better": 2.0,
    "no complaints": 1.8, "no complaint": 1.8, "no doubt": 1.0, "big thanks": 2.4, "hats off": 2.6,
    "back to normal": 1.5, "working fine": 1.8, "working now": 1.5, "working properly": 1.8,
    "working perfectly": 2.4, "fine for now": 0.3,
    # negative
    "still not fixed": -2.8, "still not resolved": -2.8, "still not repaired": -2.8,
    "still not working": -2.6, "still not cleared": -2.6, "not fixed": -2.2, "not resolved": -2.2,
    "not repaired": -2.0, "not cleaned": -1.8, "not working": -1.8, "not done": -1.6,
    "not completed": -1.6, "no action": -2.5, "no response": -2.4, "nobody came": -2.5,
    "nobody attended": -2.3, "no use": -2.2, "of no use": -2.2, "no improvement": -2.2,
    "no change": -1.6, "waste of time": -2.8, "waste of money": -2.6, "same problem": -1.8,
    "same issue": -1.8, "problem persists": -2.2, "issue persists": -2.2, "still exists": -2.0,
    "still there": -1.8, "still pending": -2.0, "still waiting": -2.0, "came back": -1.4,
    "coming back": -1.4, "comes back": -1.4, "keeps coming back": -1.8, "broke again": -2.2,
    "broken again": -2.2, "started again": -1.8, "again started": -1.8, "goes off again": -1.8,
    "goes off": -1.2, "temporary fix": -1.6, "patch work": -1.2, "half done": -1.8, "half baked": -1.8,
    "poor quality": -2.4, "low quality": -2.2, "too late": -1.8, "too slow": -2.0, "took too long": -2.2,
    "closed without": -2.0, "nothing happened": -2.2, "nothing happens": -2.2, "nothing done": -2.4,
    "nothing has changed": -2.0, "nothing changed": -2.0, "fed up": -2.4, "given up": -1.8,
    "nobody cares": -2.5, "no one cares": -2.5, "do not care": -2.0, "no accountability": -2.4,
    "no follow up": -1.8, "no update": -1.6, "so called": -1.2, "nothing special": -0.5,
    "no water": -1.5, "no light": -1.2, "no electricity": -1.4, "not acceptable": -2.0,
    "not satisfied": -2.2, "not happy": -2.2,
}

BOOSTERS = {
    "very": 0.293, "really": 0.293, "extremely": 0.293, "highly": 0.293, "so": 0.293, "totally": 0.293,
    "completely": 0.293, "absolutely": 0.293, "truly": 0.293, "deeply": 0.293, "incredibly": 0.293,
    "thoroughly": 0.293, "fully": 0.2, "quite": 0.15, "most": 0.2, "bilkul": 0.293, "ekdum": 0.293,
    "slightly": -0.293, "somewhat": -0.293, "bit": -0.293, "little": -0.293, "partially": -0.293,
    "barely": -0.293, "hardly": -0.293, "kinda": -0.293, "sorta": -0.293,
}

NEGATORS = frozenset({"not", "no", "never", "nothing", "nobody", "none", "neither", "nor", "without",
                      "cannot", "hardly"})
CONTRAST = frozenset({"but", "however", "lekin", "magar", "kaani", "kani"})
CONCESSIVE = frozenset({"although", "though", "despite", "inspite"})

SERVICE_ACTIONS = frozenset({
    "visit", "visited", "come", "came", "respond", "responded", "inspect", "inspected", "attend",
    "attended", "clean", "cleaned", "repair", "repaired", "check", "checked", "call", "called", "reply",
    "replied", "fix", "fixed", "fixing", "resolve", "resolved", "clear", "cleared", "collect",
    "collected", "done", "complete", "completed", "work", "worked", "act", "acted", "listen",
    "listened", "care", "cared", "bother", "bothered", "solution", "solved", "replaced", "removed",
    "covered", "filled", "restored", "turned", "showed", "help", "helped",
})
NEGATED_ACTION_VALENCE = -1.6

PROBLEM_STATES = frozenset({
    "open", "there", "leaking", "blocked", "broken", "hanging", "lying", "overflowing", "dark", "pending",
    "waiting", "same", "exists", "not", "no", "unbearable", "smelling", "dirty", "uneven", "damaged",
    "flooded", "stagnant", "off", "dangerous", "stinking", "piling", "unresolved",
})
PERSISTENCE_VALENCE = -1.8

EMOJI_VALENCE = {
    "\U0001F60A": 2.0, "\U0001F600": 2.0, "\U0001F603": 2.0, "\U0001F604": 2.2, "\U0001F601": 2.0,
    "\U0001F642": 1.2, "\U0001F44D": 1.8, "\U0001F44F": 2.2, "\U0001F64F": 1.6, "\u2764": 2.4,
    "\U0001F4AF": 2.0, "\u2705": 1.2, "\U0001F44C": 1.8, "\U0001F389": 2.2, "\U0001F60D": 2.6,
    "\U0001F621": -2.6, "\U0001F620": -2.4, "\U0001F92C": -3.0, "\U0001F61E": -2.0, "\U0001F622": -2.0,
    "\U0001F62D": -2.2, "\U0001F44E": -2.0, "\U0001F624": -2.0, "\U0001F612": -1.6, "\U0001F644": -1.6,
    "\U0001F4A9": -2.0, "\u274C": -1.2, "\U0001F637": -1.0, "\U0001F61F": -1.6,
}

TRANSLATIONS = {
    "accha": "good", "achha": "good", "acha": "good", "achchha": "good", "badhiya": "great",
    "badiya": "great", "badhia": "great", "zabardast": "excellent", "jabardast": "excellent",
    "shandaar": "excellent", "shandar": "excellent", "mast": "great", "shukriya": "thanks",
    "shukria": "thanks", "dhanyavad": "thanks", "dhanyavaad": "thanks", "dhanyawad": "thanks",
    "dhanyavaadalu": "thanks", "baagundi": "good", "bagundi": "good", "bagunnadi": "good",
    "manchi": "good", "bekar": "useless", "bekaar": "useless", "bakwas": "nonsense",
    "bakwaas": "nonsense", "ghatiya": "terrible", "ghatia": "terrible", "kharab": "bad",
    "kharaab": "bad", "bura": "bad", "buri": "bad", "faltu": "useless", "nikamma": "useless",
    "nikamme": "useless", "pareshan": "troubled", "pareshaan": "troubled", "pareshani": "trouble",
    "baaledu": "not good", "bagaledu": "not good", "bagoledu": "not good", "dandaga": "useless",
}
