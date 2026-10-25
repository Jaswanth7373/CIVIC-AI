"""Reference material for the CivicAI demo dataset built by ``python manage.py seed_demo``.

This module is plain data plus a few small text helpers - people, places in Hyderabad, and the templates the
seeder fills to write complaint descriptions, officer remarks, citizen feedback and review notes. Nothing here
is ever shown as AI output: the seeder submits the generated texts and sample photos through the real
submission service, and every category, severity, priority, duplicate flag, verification score and sentiment
in the demo database is computed by the AI engine from them.

Coordinates are approximate public locations (OpenStreetMap level of accuracy) of well-known Hyderabad
neighbourhoods; addresses, areas and PIN codes are consistent with the neighbourhood a complaint is placed in.
Phone numbers use the conventional ``98765 4xxxx`` placeholder series and all e-mail addresses use the
non-routable ``civicai.local`` domain, so no real person or mailbox is referenced.
"""

DEMO_EMAIL_DOMAIN = "civicai.local"
CITY = "Hyderabad"

ADMIN_ACCOUNT = {
    "email": f"admin@{DEMO_EMAIL_DOMAIN}", "password": "Admin@12345", "first_name": "Anita", "last_name": "Rao",
    "phone": "9876540000",
}
OFFICER_PASSWORD = "Officer@12345"
CITIZEN_PASSWORD = "Citizen@12345"
MAIN_CITIZEN_EMAIL = f"citizen@{DEMO_EMAIL_DOMAIN}"

# ---------------------------------------------------------------------------------------------------------------
# Places
# ---------------------------------------------------------------------------------------------------------------
#: Complaint hotspots: ~65 % of the complaints are placed around these centres (gaussian jitter ~250 m).
#: ``weight`` is the share of hotspot complaints, ``bias`` multiplies the category mix (local problems).
#: ``places`` are well-known spots of the neighbourhood (main roads, stations, markets, landmarks); its residential
#: lanes and colonies, where small, routine problems are reported, are listed in QUIET_PLACES.
HOTSPOTS = [
    {
        "key": "kukatpally", "area": "Kukatpally", "latitude": 17.4849, "longitude": 78.4138, "pincode": "500072",
        "weight": 0.19, "bias": {"drainage": 1.9, "pothole": 1.3, "garbage": 1.1},
        "places": [
            ("Kukatpally Metro Station", "NH 65, Kukatpally"), ("Kukatpally Bus Stop", "Kukatpally Main Road"),
            ("Vivekananda Nagar Park", "Vivekananda Nagar Main Road"), ("Sumitra Nagar Arch", "Sumitra Nagar Road"),
            ("KPHB Phase 1 Community Hall", "KPHB Road No. 1"), ("Ramalayam Temple", "Prashanthi Nagar Road"),
        ],
    },
    {
        "key": "ameerpet", "area": "Ameerpet", "latitude": 17.4375, "longitude": 78.4483, "pincode": "500016",
        "weight": 0.18, "bias": {"pothole": 1.6, "streetlight": 1.4, "open_manhole": 1.3},
        "places": [
            ("Ameerpet Metro Station", "Ameerpet Main Road"), ("Mythrivanam Complex", "Ameerpet Main Road"),
            ("Satyam Theatre junction", "S.R. Nagar Main Road"), ("Ameerpet Gurudwara", "Gurudwara Road"),
            ("Leelanagar Park", "Leelanagar Road"), ("Balkampet Yellamma Temple", "Balkampet Road"),
        ],
    },
    {
        "key": "dilsukhnagar", "area": "Dilsukhnagar", "latitude": 17.3688, "longitude": 78.5247,
        "pincode": "500060", "weight": 0.16, "bias": {"garbage": 1.9, "drainage": 1.4, "streetlight": 1.1},
        "places": [
            ("Dilsukhnagar Bus Stand", "Dilsukhnagar Main Road"),
            ("Dilsukhnagar Metro Station", "Dilsukhnagar Main Road"),
            ("Kothapet Fruit Market", "Kothapet Road"), ("Chaitanyapuri Colony arch", "Chaitanyapuri Main Road"),
            ("Konark Theatre", "Dilsukhnagar Main Road"), ("Moosarambagh Bridge", "Malakpet - Dilsukhnagar Road"),
        ],
    },
    {
        "key": "secunderabad", "area": "Secunderabad", "latitude": 17.4399, "longitude": 78.4983,
        "pincode": "500003", "weight": 0.14, "bias": {"pothole": 1.3, "open_manhole": 1.5, "garbage": 1.3},
        "places": [
            ("Secunderabad Railway Station", "Station Road"), ("Clock Tower", "Sarojini Devi Road"),
            ("Monda Market", "Monda Market Road"), ("Patny Centre", "Sardar Patel Road"),
            ("Rethifile Bus Station", "Station Road"), ("St. Mary's Church", "St. Mary's Road"),
        ],
    },
    {
        "key": "charminar", "area": "Charminar", "latitude": 17.3616, "longitude": 78.4747, "pincode": "500002",
        "weight": 0.12, "bias": {"garbage": 1.6, "water_leak": 1.5, "drainage": 1.2, "other": 1.4},
        "places": [
            ("Charminar", "Charminar Road"), ("Laad Bazaar", "Laad Bazaar Lane"), ("Mecca Masjid", "Charminar Road"),
            ("Gulzar Houz", "Gulzar Houz Road"), ("Pathergatti market", "Pathergatti Road"),
            ("Shalibanda junction", "Shalibanda Road"),
        ],
    },
    {
        "key": "gachibowli", "area": "Gachibowli", "latitude": 17.4401, "longitude": 78.3489, "pincode": "500032",
        "weight": 0.11, "bias": {"road_crack": 1.8, "fallen_tree": 1.5, "streetlight": 1.3},
        "places": [
            ("Gachibowli Stadium", "Old Mumbai Highway"), ("Gachibowli Flyover", "Old Mumbai Highway"),
            ("Indira Nagar Colony", "Indira Nagar Main Road"), ("Telecom Nagar Park", "Telecom Nagar Main Road"),
            ("ISB Road junction", "ISB Road"), ("DLF Cyber City gate", "Gachibowli - Miyapur Road"),
        ],
    },
    {
        "key": "banjara_hills", "area": "Banjara Hills", "latitude": 17.4156, "longitude": 78.4347,
        "pincode": "500034", "weight": 0.10, "bias": {"water_leak": 1.6, "fallen_tree": 1.5, "pothole": 1.2},
        "places": [
            ("Road No. 12 junction", "Road No. 12, Banjara Hills"), ("GVK One Mall", "Road No. 1, Banjara Hills"),
            ("KBR Park gate", "Road No. 2, Banjara Hills"), ("Care Hospital", "Road No. 1, Banjara Hills"),
            ("Banjara Hills Road No. 10 bus stop", "Road No. 10, Banjara Hills"),
            ("Lotus Pond", "Road No. 3, Banjara Hills"),
        ],
    },
]

#: Other neighbourhoods for the ~35 % of complaints scattered across the city (wider jitter ~500 m).
LOCALITIES = [
    {"area": "Madhapur", "latitude": 17.4483, "longitude": 78.3915, "pincode": "500081",
     "places": [("Madhapur Police Station", "Ayyappa Society Main Road"), ("Shilparamam", "HITEC City Road")]},
    {"area": "Kondapur", "latitude": 17.4600, "longitude": 78.3600, "pincode": "500084",
     "places": [("Botanical Garden junction", "Kondapur Main Road"), ("Raghavendra Colony", "Kothaguda Road")]},
    {"area": "Miyapur", "latitude": 17.4968, "longitude": 78.3614, "pincode": "500049",
     "places": [("Miyapur Metro Depot", "Miyapur Main Road"), ("Allwyn Colony", "Allwyn X Roads")]},
    {"area": "Begumpet", "latitude": 17.4447, "longitude": 78.4664, "pincode": "500016",
     "places": [("Begumpet Railway Station", "Begumpet Road"), ("Prakash Nagar", "Prakash Nagar Main Road")]},
    {"area": "Jubilee Hills", "latitude": 17.4325, "longitude": 78.4073, "pincode": "500033",
     "places": [("Jubilee Hills Check Post", "Road No. 36, Jubilee Hills"), ("Film Nagar", "Film Nagar Road")]},
    {"area": "Mehdipatnam", "latitude": 17.3930, "longitude": 78.4400, "pincode": "500028",
     "places": [("Mehdipatnam Bus Depot", "Mehdipatnam Main Road"), ("Rythu Bazaar", "Gudimalkapur Road")]},
    {"area": "Tolichowki", "latitude": 17.3984, "longitude": 78.4152, "pincode": "500008",
     "places": [("Tolichowki flyover", "Tolichowki Main Road"), ("Seven Tombs Road", "Seven Tombs Road")]},
    {"area": "Himayatnagar", "latitude": 17.4022, "longitude": 78.4867, "pincode": "500029",
     "places": [("Himayatnagar Main Road", "Himayatnagar Main Road"), ("Liberty junction", "Liberty Road")]},
    {"area": "Abids", "latitude": 17.3920, "longitude": 78.4760, "pincode": "500001",
     "places": [("GPO Abids", "Abids Road"), ("Bogulkunta", "Tilak Road")]},
    {"area": "Malakpet", "latitude": 17.3730, "longitude": 78.5000, "pincode": "500036",
     "places": [("Malakpet Railway Station", "Malakpet Main Road"), ("Race Course Road", "Race Course Road")]},
    {"area": "LB Nagar", "latitude": 17.3457, "longitude": 78.5522, "pincode": "500074",
     "places": [("LB Nagar Ring Road", "LB Nagar Main Road"), ("Kamineni Hospital", "Kamineni Road")]},
    {"area": "Uppal", "latitude": 17.4058, "longitude": 78.5591, "pincode": "500039",
     "places": [("Uppal Ring Road", "Uppal Main Road"), ("Uppal Bus Depot", "Warangal Highway")]},
    {"area": "Tarnaka", "latitude": 17.4285, "longitude": 78.5300, "pincode": "500017",
     "places": [("Tarnaka junction", "Tarnaka Main Road"), ("Lalaguda", "Lalaguda Road")]},
    {"area": "Kompally", "latitude": 17.5360, "longitude": 78.4840, "pincode": "500014",
     "places": [("Kompally Main Road", "Kompally Main Road"), ("Suchitra Circle", "Suchitra Road")]},
    {"area": "Attapur", "latitude": 17.3700, "longitude": 78.4300, "pincode": "500048",
     "places": [("Attapur pillar no. 140", "PVNR Expressway service road"), ("Hyderguda", "Attapur Main Road")]},
    {"area": "Saroornagar", "latitude": 17.3530, "longitude": 78.5330, "pincode": "500035",
     "places": [("Saroornagar Lake", "Saroornagar Main Road"), ("Victoria Memorial Home", "Saroornagar Road")]},
    {"area": "Manikonda", "latitude": 17.4050, "longitude": 78.3860, "pincode": "500089",
     "places": [("Manikonda Panchavati Colony", "Manikonda Main Road"), ("Alkapur Township", "Puppalaguda Road")]},
    {"area": "Nallakunta", "latitude": 17.3990, "longitude": 78.5050, "pincode": "500044",
     "places": [("Nallakunta Market", "Nallakunta Main Road"), ("Shankarmutt", "Vidyanagar Road")]},
    {"area": "Somajiguda", "latitude": 17.4240, "longitude": 78.4580, "pincode": "500082",
     "places": [("Somajiguda Circle", "Raj Bhavan Road"), ("Yashoda Hospital", "Somajiguda Main Road")]},
    {"area": "Lingampally", "latitude": 17.4900, "longitude": 78.3170, "pincode": "500019",
     "places": [("Lingampally Railway Station", "Lingampally Main Road"), ("BHEL township gate", "BHEL Road")]},
    {"area": "Habsiguda", "latitude": 17.4130, "longitude": 78.5400, "pincode": "500007",
     "places": [("Habsiguda X Roads", "Habsiguda Main Road"), ("Street No. 8", "Habsiguda Street No. 8")]},
    {"area": "Moosapet", "latitude": 17.4700, "longitude": 78.4250, "pincode": "500018",
     "places": [("Moosapet Metro Station", "Moosapet Main Road"), ("Bharat Nagar", "Bharat Nagar Road")]},
    {"area": "Bowenpally", "latitude": 17.4720, "longitude": 78.4800, "pincode": "500011",
     "places": [("Bowenpally Market", "Bowenpally Main Road"), ("Old Bowenpally", "Hasmathpet Road")]},
    {"area": "Chanda Nagar", "latitude": 17.4930, "longitude": 78.3290, "pincode": "500050",
     "places": [("Chanda Nagar bus stop", "Old Mumbai Highway"), ("Gangaram", "Chanda Nagar Main Road")]},
]

#: Residential lanes and colonies (landmark, road) per hotspot key / locality area. Routine, low-impact problems
#: (a full bin, a flickering lamp, hairline cracks) are mostly reported from such streets: the names carry no
#: traffic or sensitive-place words, so the AI's location-risk factor stays low there.
QUIET_PLACES = {
    "kukatpally": [("Prashanthi Nagar colony park", "Lane 3, Prashanthi Nagar"),
                   ("Vasanth Nagar community hall", "Road No. 2, Vasanth Nagar"),
                   ("Sardar Patel Nagar", "Street No. 5, Sardar Patel Nagar")],
    "ameerpet": [("Srinivasa Nagar colony", "Lane 4, Srinivasa Nagar"),
                 ("Nagarjuna Nagar park", "Street No. 2, Nagarjuna Nagar"),
                 ("Leelanagar colony", "Lane 1, Leelanagar")],
    "dilsukhnagar": [("Kamala Nagar colony", "Lane 2, Kamala Nagar"),
                     ("Vasavi Colony park", "Street No. 6, Vasavi Colony"),
                     ("Chaitanyapuri residents' hall", "Lane 5, Chaitanyapuri")],
    "secunderabad": [("West Marredpally colony", "Road No. 3, West Marredpally"),
                     ("Chilkalguda lane", "Lane 2, Chilkalguda"),
                     ("Namalagundu colony", "Street No. 1, Namalagundu")],
    "charminar": [("Shah Ali Banda lane", "Lane 4, Shah Ali Banda"),
                  ("Hussaini Alam colony", "Street No. 3, Hussaini Alam"),
                  ("Dabeerpura residents' park", "Lane 1, Dabeerpura")],
    "gachibowli": [("Telecom Nagar colony", "Street No. 4, Telecom Nagar"),
                   ("Indira Nagar park", "Lane 6, Indira Nagar"),
                   ("Gopanpally colony", "Lane 2, Gopanpally")],
    "banjara_hills": [("NBT Nagar colony", "Lane 3, NBT Nagar"),
                      ("MLA Colony park", "Road No. 12A, MLA Colony"),
                      ("Shaikpet lane", "Street No. 2, Shaikpet")],
    "Madhapur": [("Kavuri Hills Phase 2", "Street No. 4, Kavuri Hills"),
                 ("Ayyappa Society lane", "Lane 5, Ayyappa Society")],
    "Kondapur": [("Sriram Nagar colony", "Lane 2, Sriram Nagar"),
                 ("Masjid Banda colony", "Street No. 3, Masjid Banda")],
    "Miyapur": [("Matrusri Nagar park", "Lane 7, Matrusri Nagar"),
                ("Deepthi Sri Nagar", "Street No. 2, Deepthi Sri Nagar")],
    "Begumpet": [("Brahmanwadi colony", "Lane 3, Brahmanwadi"), ("Patigadda lane", "Street No. 1, Patigadda")],
    "Jubilee Hills": [("Journalist Colony park", "Road No. 70, Journalist Colony"),
                      ("Venkatagiri colony", "Lane 2, Venkatagiri")],
    "Mehdipatnam": [("Humayun Nagar colony", "Lane 4, Humayun Nagar"),
                    ("Vijay Nagar Colony", "Street No. 5, Vijay Nagar Colony")],
    "Tolichowki": [("Paramount Colony", "Lane 3, Paramount Colony"), ("Nadeem Colony", "Street No. 2, Nadeem Colony")],
    "Himayatnagar": [("Urdu Hall lane", "Urdu Hall Lane"),
                     ("Himayatnagar Street No. 14", "Street No. 14, Himayatnagar")],
    "Abids": [("Chirag Ali Lane", "Chirag Ali Lane"), ("Gunfoundry colony", "Lane 2, Gunfoundry")],
    "Malakpet": [("Saleem Nagar Colony", "Lane 3, Saleem Nagar"),
                 ("Old Malakpet colony", "Street No. 4, Old Malakpet")],
    "LB Nagar": [("Bhavani Nagar Colony", "Lane 2, Bhavani Nagar"),
                 ("Chintalkunta colony", "Street No. 3, Chintalkunta")],
    "Uppal": [("Kalyanpuri Colony", "Lane 5, Kalyanpuri"), ("Saraswathi Colony", "Street No. 2, Saraswathi Colony")],
    "Tarnaka": [("Vijayapuri Colony", "Lane 1, Vijayapuri"), ("Tarnaka Street No. 1", "Street No. 1, Tarnaka")],
    "Kompally": [("Pragathi Enclave", "Lane 4, Pragathi Enclave"),
                 ("Suchitra Enclave", "Street No. 2, Suchitra Enclave")],
    "Attapur": [("Ganga Nagar Colony", "Lane 4, Ganga Nagar"), ("Sai Nagar colony", "Street No. 2, Sai Nagar")],
    "Saroornagar": [("HUDA Colony", "Street No. 3, HUDA Colony"), ("Teachers Colony", "Lane 2, Teachers Colony")],
    "Manikonda": [("Panchavati Colony park", "Lane 2, Panchavati Colony"), ("OU Colony", "Street No. 6, OU Colony")],
    "Nallakunta": [("Padma Colony", "Lane 3, Padma Colony"), ("Vidyanagar colony", "Street No. 2, Vidyanagar")],
    "Somajiguda": [("Kapadia Lane", "Kapadia Lane"), ("Yellareddyguda colony", "Street No. 4, Yellareddyguda")],
    "Lingampally": [("Nallagandla HUDA layout", "Lane 2, Nallagandla"), ("Gopi Nagar", "Street No. 1, Gopi Nagar")],
    "Habsiguda": [("Ravindra Nagar", "Lane 4, Ravindra Nagar"), ("Kakatiya Nagar", "Street No. 3, Kakatiya Nagar")],
    "Moosapet": [("Avanthi Nagar", "Lane 2, Avanthi Nagar"), ("Anjaiah Nagar", "Street No. 5, Anjaiah Nagar")],
    "Bowenpally": [("Vasavi Nagar", "Lane 3, Vasavi Nagar"), ("Chinna Thokatta", "Street No. 2, Chinna Thokatta")],
    "Chanda Nagar": [("Deepthi Nagar", "Lane 1, Deepthi Nagar"), ("Rail Vihar colony", "Street No. 2, Rail Vihar")],
}

#: Short bursts of reports: one weather or civic event produces several reports of different kinds within a day or
#: two in one neighbourhood - the situation the hotspot alerts are built for. ``age`` is in days before the end of
#: the history (default dates: early June storm, late-July downpour, early-September waste backlog);
#: ``reports`` are the categories in the order they arrive, spread over ``hours`` within ``radius_m`` of a point
#: near the centre of the hotspot ``spot``.
EVENTS = [
    {"key": "june_storm", "spot": "banjara_hills", "age": 133.4, "hours": 20, "radius_m": 260,
     "reports": ["fallen_tree", "streetlight", "fallen_tree", "pothole", "fallen_tree"]},
    {"key": "july_downpour", "spot": "kukatpally", "age": 88.3, "hours": 30, "radius_m": 260,
     "reports": ["drainage", "pothole", "drainage", "streetlight", "drainage", "road_crack"]},
    {"key": "waste_backlog", "spot": "dilsukhnagar", "age": 41.6, "hours": 36, "radius_m": 250,
     "reports": ["garbage", "drainage", "garbage", "other", "garbage"]},
]

#: How a citizen describes a problem of each category: "minor" (a routine request, no hazard), "standard" (the
#: problem and its main consequence) or "severe" (danger to people, vulnerable groups, urgency). Reports from the
#: scattered localities lean towards minor ones, hotspot reports towards severe ones (``TONE_SPOT_FACTORS``).
TONE_WEIGHTS = {
    "pothole": {"minor": 0.10, "standard": 0.62, "severe": 0.28},
    "garbage": {"minor": 0.42, "standard": 0.46, "severe": 0.12},
    "drainage": {"minor": 0.22, "standard": 0.53, "severe": 0.25},
    "streetlight": {"minor": 0.28, "standard": 0.50, "severe": 0.22},
    "water_leak": {"minor": 0.40, "standard": 0.42, "severe": 0.18},
    "open_manhole": {"minor": 0.0, "standard": 0.55, "severe": 0.45},
    "road_crack": {"minor": 0.45, "standard": 0.45, "severe": 0.10},
    "fallen_tree": {"minor": 0.15, "standard": 0.50, "severe": 0.35},
    "other": {"minor": 0.60, "standard": 0.37, "severe": 0.03},
}
TONE_SPOT_FACTORS = {"hotspot": {"minor": 0.7, "severe": 1.15}, "locality": {"minor": 1.6, "severe": 0.8}}

# ---------------------------------------------------------------------------------------------------------------
# People
# ---------------------------------------------------------------------------------------------------------------
#: Department code -> e-mail prefix (``roads.officer1@civicai.local``) and employee-id prefix (``RD-1001``).
DEPARTMENT_PREFIXES = {
    "ROADS": ("roads", "RD", 1000), "WASTE": ("waste", "WM", 2000), "DRAIN": ("drain", "DR", 3000),
    "ELEC": ("elec", "EL", 4000), "WATER": ("water", "WS", 5000), "PARKS": ("parks", "PK", 6000),
    "GEN": ("gen", "GN", 7000),
}

#: Officers per department (in e-mail order: the first entry becomes ``<prefix>.officer1``). ``base`` is the
#: officer's field office (lat, lng); exactly one officer goes on leave during the demo period (``on_leave``).
OFFICERS = {
    "ROADS": [
        {"first_name": "Ravi", "last_name": "Kumar", "designation": "Assistant Engineer (Roads)",
         "zone": "Khairatabad Zone - Ameerpet (Ward 97)", "base": (17.4368, 78.4462), "capacity": 15,
         "skills": ["pothole repair", "road resurfacing", "manhole safety"], "joined_on": "2016-07-11",
         "phone": "9876541001"},
        {"first_name": "Srinivas", "last_name": "Goud", "designation": "Junior Engineer (Roads)",
         "zone": "Kukatpally Zone - KPHB (Ward 114)", "base": (17.4862, 78.4094), "capacity": 12,
         "skills": ["pothole repair", "crack sealing"], "joined_on": "2019-03-04", "phone": "9876541002"},
        {"first_name": "Fatima", "last_name": "Begum", "designation": "Field Officer (Roads)",
         "zone": "Charminar Zone - Dilsukhnagar (Ward 30)", "base": (17.3672, 78.5072), "capacity": 10,
         "skills": ["road restoration", "footpath repair"], "joined_on": "2021-01-18", "phone": "9876541003"},
    ],
    "WASTE": [
        {"first_name": "Lakshmi", "last_name": "Prasanna", "designation": "Sanitary Inspector",
         "zone": "Secunderabad Zone - Monda Market (Ward 148)", "base": (17.4380, 78.4990), "capacity": 14,
         "skills": ["garbage clearance", "bin management"], "joined_on": "2015-09-21", "phone": "9876542001"},
        {"first_name": "Mohammed", "last_name": "Irfan", "designation": "Sanitary Supervisor",
         "zone": "Charminar Zone - Pathergatti (Ward 49)", "base": (17.3640, 78.4790), "capacity": 12,
         "skills": ["garbage clearance", "night sweeping"], "joined_on": "2018-02-12", "phone": "9876542002"},
        {"first_name": "Venkatesh", "last_name": "Yadav", "designation": "Sanitary Inspector",
         "zone": "Serilingampally Zone - Gachibowli (Ward 105)", "base": (17.4420, 78.3560), "capacity": 10,
         "skills": ["garbage clearance", "debris removal"], "joined_on": "2020-06-29", "phone": "9876542003",
         "on_leave": True},
    ],
    "DRAIN": [
        {"first_name": "Naveen", "last_name": "Chowdary", "designation": "Assistant Engineer (Drainage)",
         "zone": "Kukatpally Zone - Vivekananda Nagar (Ward 116)", "base": (17.4835, 78.4170), "capacity": 13,
         "skills": ["desilting", "sewer jetting"], "joined_on": "2017-08-07", "phone": "9876543001"},
        {"first_name": "Sunitha", "last_name": "Rani", "designation": "Junior Engineer (Drainage)",
         "zone": "LB Nagar Zone - Chaitanyapuri (Ward 22)", "base": (17.3705, 78.5310), "capacity": 11,
         "skills": ["storm-water drains", "desilting"], "joined_on": "2020-11-16", "phone": "9876543002"},
    ],
    "ELEC": [
        {"first_name": "Harish", "last_name": "Varma", "designation": "Assistant Engineer (Electrical)",
         "zone": "Khairatabad Zone - Somajiguda (Ward 97)", "base": (17.4270, 78.4520), "capacity": 12,
         "skills": ["streetlight repair", "cable faults"], "joined_on": "2014-04-28", "phone": "9876544001"},
        {"first_name": "Prakash", "last_name": "Rao", "designation": "Lineman Supervisor",
         "zone": "Secunderabad Zone - Tarnaka (Ward 145)", "base": (17.4300, 78.5150), "capacity": 9,
         "skills": ["streetlight repair", "pole replacement"], "joined_on": "2019-10-14", "phone": "9876544002"},
    ],
    "WATER": [
        {"first_name": "Deepika", "last_name": "Iyer", "designation": "Assistant Engineer (Water Supply)",
         "zone": "Khairatabad Zone - Banjara Hills (Ward 93)", "base": (17.4170, 78.4380), "capacity": 12,
         "skills": ["pipeline repair", "valve maintenance"], "joined_on": "2018-05-21", "phone": "9876545001"},
        {"first_name": "Abdul", "last_name": "Rahman", "designation": "Field Officer (Water Supply)",
         "zone": "Charminar Zone - Shalibanda (Ward 52)", "base": (17.3600, 78.4700), "capacity": 10,
         "skills": ["leak detection", "pipeline repair"], "joined_on": "2022-02-07", "phone": "9876545002"},
    ],
    "PARKS": [
        {"first_name": "Swathi", "last_name": "Reddy", "designation": "Horticulture Officer",
         "zone": "Serilingampally Zone - Gachibowli (Ward 105)", "base": (17.4390, 78.3620), "capacity": 10,
         "skills": ["tree removal", "pruning"], "joined_on": "2017-12-04", "phone": "9876546001"},
        {"first_name": "Ramesh", "last_name": "Naik", "designation": "Field Supervisor (Public Works)",
         "zone": "Khairatabad Zone - Banjara Hills (Ward 93)", "base": (17.4200, 78.4300), "capacity": 8,
         "skills": ["tree removal", "obstruction clearance"], "joined_on": "2021-08-23", "phone": "9876546002"},
    ],
    "GEN": [
        {"first_name": "Kiran", "last_name": "Kumar", "designation": "Ward Officer",
         "zone": "Khairatabad Zone (general)", "base": (17.4100, 78.4600), "capacity": 12,
         "skills": ["triage", "enforcement coordination"], "joined_on": "2016-01-11", "phone": "9876547001"},
        {"first_name": "Anjali", "last_name": "Deshmukh", "designation": "Assistant Ward Officer",
         "zone": "Secunderabad Zone (general)", "base": (17.4450, 78.4950), "capacity": 10,
         "skills": ["triage", "public grievances"], "joined_on": "2023-03-13", "phone": "9876547002"},
    ],
}

#: The main demo citizen (``citizen@civicai.local``) followed by citizen1 ... citizen15.
CITIZENS = [
    {"first_name": "Rahul", "last_name": "Verma", "phone": "9876543210", "area": "Ameerpet", "pincode": "500038",
     "address": "Flat 302, Sai Residency, S.R. Nagar", "gender": "male", "date_of_birth": "1996-03-14",
     "language": "en", "home": "ameerpet"},
    {"first_name": "Priya", "last_name": "Nair", "phone": "9876543211", "area": "Kukatpally", "pincode": "500072",
     "address": "H.No. 15-31-412, KPHB Colony", "gender": "female", "date_of_birth": "1992-07-02",
     "language": "en", "home": "kukatpally"},
    {"first_name": "Arjun", "last_name": "Reddy", "phone": "9876543212", "area": "Gachibowli", "pincode": "500032",
     "address": "Villa 18, Indira Nagar", "gender": "male", "date_of_birth": "1989-11-23", "language": "te",
     "home": "gachibowli"},
    {"first_name": "Sneha", "last_name": "Patel", "phone": "9876543213", "area": "Secunderabad", "pincode": "500003",
     "address": "2-4-117, Sarojini Devi Road", "gender": "female", "date_of_birth": "1998-01-30",
     "language": "en", "home": "secunderabad"},
    {"first_name": "Mohammed", "last_name": "Faizan", "phone": "9876543214", "area": "Charminar",
     "pincode": "500002", "address": "22-1-519, Pathergatti", "gender": "male", "date_of_birth": "1987-05-09",
     "language": "hi", "home": "charminar"},
    {"first_name": "Kavya", "last_name": "Rao", "phone": "9876543215", "area": "Banjara Hills", "pincode": "500034",
     "address": "8-2-293, Road No. 12", "gender": "female", "date_of_birth": "1994-09-17", "language": "en",
     "home": "banjara_hills"},
    {"first_name": "Vikram", "last_name": "Singh", "phone": "9876543216", "area": "Dilsukhnagar",
     "pincode": "500060", "address": "16-11-740, Moosarambagh", "gender": "male", "date_of_birth": "1985-12-01",
     "language": "hi", "home": "dilsukhnagar"},
    {"first_name": "Ayesha", "last_name": "Siddiqui", "phone": "9876543217", "area": "Tolichowki",
     "pincode": "500008", "address": "Flat 5B, Galaxy Apartments, Tolichowki", "gender": "female",
     "date_of_birth": "1993-04-26", "language": "en", "home": "charminar"},
    {"first_name": "Sai", "last_name": "Teja", "phone": "9876543218", "area": "Kukatpally", "pincode": "500072",
     "address": "Plot 77, Vivekananda Nagar", "gender": "male", "date_of_birth": "2000-08-12", "language": "te",
     "home": "kukatpally"},
    {"first_name": "Divya", "last_name": "Menon", "phone": "9876543219", "area": "Madhapur", "pincode": "500081",
     "address": "Flat 1104, Cyber Heights, Madhapur", "gender": "female", "date_of_birth": "1991-02-08",
     "language": "en", "home": "gachibowli"},
    {"first_name": "Rohan", "last_name": "Gupta", "phone": "9876543220", "area": "Begumpet", "pincode": "500016",
     "address": "1-10-72, Prakash Nagar", "gender": "male", "date_of_birth": "1997-06-19", "language": "hi",
     "home": "ameerpet"},
    {"first_name": "Lavanya", "last_name": "Kumari", "phone": "9876543221", "area": "LB Nagar", "pincode": "500074",
     "address": "3-5-88, Kamineni Road", "gender": "female", "date_of_birth": "1990-10-05", "language": "te",
     "home": "dilsukhnagar"},
    {"first_name": "Imran", "last_name": "Khan", "phone": "9876543222", "area": "Malakpet", "pincode": "500036",
     "address": "16-3-219, Old Malakpet", "gender": "male", "date_of_birth": "1988-03-27", "language": "hi",
     "home": "charminar"},
    {"first_name": "Meghana", "last_name": "Rao", "phone": "9876543223", "area": "Miyapur", "pincode": "500049",
     "address": "Flat 402, Lake View Towers, Miyapur", "gender": "female", "date_of_birth": "1995-12-14",
     "language": "te", "home": "kukatpally"},
    {"first_name": "Karthik", "last_name": "Subramanian", "phone": "9876543224", "area": "Kondapur",
     "pincode": "500084", "address": "Villa 9, Raghavendra Colony", "gender": "male",
     "date_of_birth": "1986-07-31", "language": "en", "home": "gachibowli"},
    {"first_name": "Pooja", "last_name": "Agarwal", "phone": "9876543225", "area": "Himayatnagar",
     "pincode": "500029", "address": "3-6-111, Himayatnagar", "gender": "female", "date_of_birth": "1999-04-03",
     "language": "hi", "home": "secunderabad"},
]

# ---------------------------------------------------------------------------------------------------------------
# Complaint mix
# ---------------------------------------------------------------------------------------------------------------
#: Relative frequency of each category before hotspot bias and seasonality.
CATEGORY_WEIGHTS = {
    "pothole": 0.20, "garbage": 0.17, "drainage": 0.13, "streetlight": 0.13, "water_leak": 0.10,
    "open_manhole": 0.06, "road_crack": 0.09, "fallen_tree": 0.06, "other": 0.06,
}

#: Month -> category multipliers (Hyderabad: hot dry summer Apr-May, south-west monsoon Jun-Sep, retreating
#: monsoon rains in October).
SEASONAL_FACTORS = {
    4: {"water_leak": 1.5, "garbage": 1.2, "drainage": 0.6, "fallen_tree": 0.8},
    5: {"water_leak": 1.5, "garbage": 1.2, "drainage": 0.6, "fallen_tree": 1.2},
    6: {"drainage": 1.4, "pothole": 1.2, "fallen_tree": 1.4},
    7: {"drainage": 1.8, "pothole": 1.4, "fallen_tree": 1.6, "water_leak": 0.8},
    8: {"drainage": 1.9, "pothole": 1.5, "fallen_tree": 1.5, "water_leak": 0.8},
    9: {"drainage": 1.7, "pothole": 1.5, "fallen_tree": 1.3, "road_crack": 1.2},
    10: {"drainage": 1.4, "pothole": 1.4, "road_crack": 1.2},
}

#: (English phrase, hours since the issue began, Hinglish phrase, Telugu-English phrase)
DURATIONS = [
    ("since this morning", 5, "aaj subah se", "ee roju podduna nunchi"),
    ("since yesterday", 24, "kal se", "ninna nunchi"),
    ("for two days now", 48, "do din se", "rendu rojula nunchi"),
    ("for the last three days", 72, "teen din se", "moodu rojula nunchi"),
    ("for almost a week", 150, "lagbhag ek hafte se", "dadapu vaaram rojula nunchi"),
    ("since last week", 190, "pichle hafte se", "poyina vaaram nunchi"),
    ("for more than ten days", 260, "das din se zyada", "padi rojula kanna ekkuva nunchi"),
    ("for nearly two weeks", 320, "do hafte se", "rendu vaaraala nunchi"),
]

#: Category-specific consequences (lower-case clauses).
HAZARDS = {
    "pothole": [
        "two-wheelers are skidding while trying to avoid it",
        "school children have to step onto the main road to walk around it",
        "two bikers already fell here at night",
        "vehicles brake suddenly and it causes a traffic jam every evening",
        "it is hard to see at night and autos keep hitting it",
        "an ambulance had to slow down badly here yesterday",
    ],
    "garbage": [
        "the smell is unbearable and stray dogs scatter it across the road",
        "mosquitoes are breeding and children in the colony are falling sick",
        "it is right next to the vegetable market and the bus stop",
        "people burn it at night and the smoke enters our houses",
        "it is blocking half of the footpath",
        "cows and dogs keep tearing open the bags",
    ],
    "drainage": [
        "dirty water is entering houses and shops",
        "the stench is unbearable and mosquitoes are everywhere",
        "two-wheelers are getting stuck in knee-deep water",
        "pedestrians are forced to walk through sewage",
        "the water has not receded even after two days",
        "it overflows onto the road every time it rains",
    ],
    "streetlight": [
        "the whole lane is pitch dark after 7 pm",
        "women and senior citizens are scared to walk here at night",
        "there were two chain-snatching incidents on this stretch",
        "vehicles cannot see the speed breaker in the dark",
        "the pole is also leaning dangerously",
        "a loose wire is hanging from the pole",
    ],
    "water_leak": [
        "thousands of litres of drinking water are wasted every day",
        "the road is always wet and slippery",
        "our colony is getting very low water pressure because of the leak",
        "the leaking water is mixing with drain water",
        "a big puddle has formed and vehicles splash pedestrians",
        "the leak is washing away the road surface",
    ],
    "open_manhole": [
        "it is not visible at night and someone can easily fall in",
        "school children walk past it every morning",
        "a two-wheeler almost fell into it yesterday",
        "it is in the middle of a busy road with heavy traffic",
        "the broken lid is lying next to it",
        "there is no barricade or warning sign",
    ],
    "road_crack": [
        "the cracks are widening and the road is becoming uneven",
        "bikes are losing balance on the broken surface",
        "the cracked portion will soon become a pothole",
        "the tar is peeling off in big pieces",
        "the stretch is very bumpy for ambulances",
        "heavy trucks have damaged the surface badly",
    ],
    "fallen_tree": [
        "it is blocking one full lane of traffic",
        "the branches are resting on the electric wires",
        "a parked car has been damaged",
        "pedestrians cannot use the footpath",
        "vehicles are taking a long detour",
        "it fell during the heavy rain and wind last night",
        "ambulances cannot reach the hospital gate",
    ],
    "other": [
        "children are scared to walk to school",
        "it causes a traffic jam every evening",
        "senior citizens cannot walk on the footpath",
        "residents are unable to sleep at night",
        "commuters are forced to walk on the main road",
        "it has become a daily public nuisance",
    ],
}

#: Complaint descriptions by language (English, Hinglish, Telugu-English). Slots: {landmark}, {road}, {area},
#: {duration}, {hazard}, {hazard_sentence}, {hi_duration}, {te_duration}.
COMPLAINT_TEMPLATES = {
    "pothole": {
        "en": [
            "Big pothole on {road} near {landmark}. It has been there {duration} and {hazard}.",
            "There is a deep pothole in the middle of {road} close to {landmark}; {hazard}. Please repair it "
            "before someone gets hurt.",
            "Multiple potholes have formed on {road} after the recent rains. The biggest one is right in "
            "front of {landmark} and {hazard}.",
            "The road near {landmark} is full of potholes {duration}. Auto drivers avoid this stretch and "
            "{hazard}.",
            "A crater-like pothole has opened up on {road} near {landmark}. Rain water fills it, so it is "
            "hard to judge the depth and {hazard}.",
            "Pothole near {landmark} on {road} is getting bigger every day {duration}; {hazard}. Kindly fill "
            "it at the earliest.",
            "Dangerous pothole at the turning next to {landmark} in {area}; {hazard}.",
        ],
        "hi": [
            "{road} pe {landmark} ke paas bahut bada gaddha hai, {hi_duration} aise hi pada hai. Raat ko "
            "bikes gir rahe hain, please jaldi repair karo.",
            "{landmark} ke saamne road mein khadda ho gaya hai {hi_duration}. Gaadiyan slip ho rahi hain, koi "
            "dhyan nahi de raha.",
        ],
        "te": [
            "{landmark} daggara road meeda pedda gunta undi, {te_duration} alage undi. Bikes slip avutunnayi, "
            "please repair cheyyandi.",
            "{road} lo {landmark} pakkana gunta padindi, {te_duration} evaru pattinchukovatledu. Pothole "
            "valla accidents avutunnayi.",
        ],
    },
    "garbage": {
        "en": [
            "Garbage has not been collected near {landmark} on {road} {duration}; {hazard}.",
            "The dustbin near {landmark} is overflowing and waste is spread all over {road}. "
            "{hazard_sentence}",
            "Huge garbage dump on the roadside next to {landmark} in {area}; {hazard}. Please clear it and "
            "place a bigger bin.",
            "Nobody has lifted the garbage near {landmark} {duration}. Plastic bags and food waste are "
            "rotting and {hazard}.",
            "People are dumping construction waste and household trash at the corner of {road} near "
            "{landmark}; {hazard}.",
            "The garbage collection vehicle has not come to our lane near {landmark} {duration}, so trash is "
            "piling up and {hazard}.",
        ],
        "hi": [
            "{landmark} ke paas kachra {hi_duration} pada hai, koi uthane nahi aaya. Bahut badboo aa rahi hai "
            "aur kutte sab taraf faila rahe hain.",
            "{road} par kooda ka dher lag gaya hai {landmark} ke saamne, {hi_duration} safai nahi hui.",
        ],
        "te": [
            "{landmark} daggara chetta {te_duration} alage undi, evaru teeskelledu. Vasana "
            "bharinchalekapotunnam.",
            "{road} lo chetta kuppa nindipoyi road meedaki vachindi, {te_duration} garbage van raaledu.",
        ],
    },
    "drainage": {
        "en": [
            "The drain near {landmark} on {road} is blocked and overflowing {duration}; {hazard}.",
            "Sewage water is flowing on {road} near {landmark}. The drain is clogged and {hazard}.",
            "Severe waterlogging near {landmark} in {area} after every rain; {hazard}. The storm water drain "
            "needs desilting.",
            "The open nala next to {landmark} is choked with silt and plastic {duration}, and {hazard}.",
            "Drainage overflow on {road} close to {landmark} {duration}. {hazard_sentence}",
            "The road near {landmark} gets flooded because the drain inlets are blocked; {hazard}.",
        ],
        "hi": [
            "{landmark} ke paas nala overflow ho raha hai {hi_duration}, gutter ka paani road pe beh raha "
            "hai. Bahut gandagi hai.",
            "{road} pe drainage block hai {hi_duration}, sewage ghar ke andar aa raha hai.",
        ],
        "te": [
            "{landmark} daggara drainage block ayyi murugu neeru road meeda paarutundi, {te_duration} alage "
            "undi.",
            "{road} lo nala overflow avutundi, {te_duration} waterlogging tho nadavalekapotunnam.",
        ],
    },
    "streetlight": {
        "en": [
            "Streetlights on {road} near {landmark} are not working {duration}; {hazard}.",
            "The street light pole outside {landmark} has been off {duration} and {hazard}.",
            "Most of the street lights between {landmark} and the next junction on {road} are dead; {hazard}.",
            "The streetlight near {landmark} keeps flickering and goes off by 9 pm; {hazard}.",
            "Dark stretch on {road} near {landmark} because the street lights are not working; {hazard}.",
            "The lamp post near {landmark} in {area} is broken and the bulb is missing {duration}; {hazard}.",
        ],
        "hi": [
            "{landmark} ke paas street light {hi_duration} band hai, raat ko poora andhera rehta hai. Ladies "
            "ko aane jaane mein dar lagta hai.",
            "{road} pe bijli ke khambe ki light kharab hai {hi_duration}, wire bhi latak raha hai.",
        ],
        "te": [
            "{landmark} daggara street light {te_duration} veligatledu, raatri antha cheekati ga undi. Light "
            "ledu valla bhayam ga undi.",
            "{road} lo street lights {te_duration} pani cheyyatledu, current pole meeda wire veladutundi.",
        ],
    },
    "water_leak": {
        "en": [
            "Drinking water pipeline is leaking on {road} near {landmark} {duration}; {hazard}.",
            "A water pipe has burst near {landmark} and clean water is flowing onto {road}; {hazard}.",
            "There is a continuous water leak from the valve near {landmark} in {area}; {hazard}.",
            "The main water supply line near {landmark} is leaking {duration} and {hazard}.",
            "Water leakage from the underground pipeline on {road} close to {landmark}. {hazard_sentence}",
            "A tap connection near {landmark} is broken and water keeps leaking {duration}; {hazard}.",
        ],
        "hi": [
            "{landmark} ke paas pipeline leak ho rahi hai {hi_duration}, peene ka paani road pe beh raha hai. "
            "Paani ki bahut wastage ho rahi hai.",
            "{road} pe paani ki pipe phat gayi hai, {hi_duration} paani waste ho raha hai.",
        ],
        "te": [
            "{landmark} daggara water pipeline leak avutundi, {te_duration} manchi neellu road meeda vrudha "
            "avutunnayi.",
            "{road} lo pipe burst ayyi neeru paarutundi, {te_duration} evaru repair cheyyaledu.",
        ],
    },
    "open_manhole": {
        "en": [
            "Open manhole on {road} near {landmark} without any cover; {hazard}.",
            "The manhole cover near {landmark} is missing {duration} and {hazard}. This is very dangerous.",
            "An uncovered manhole in the middle of {road} close to {landmark}; {hazard}. Please cover it "
            "immediately.",
            "The drain chamber lid near {landmark} in {area} is broken and the manhole is open; {hazard}.",
            "Deep open manhole next to the footpath at {landmark} {duration}; {hazard}.",
            "Manhole near {landmark} is left open after cleaning work and {hazard}.",
        ],
        "hi": [
            "{landmark} ke paas manhole khula pada hai {hi_duration}, dhakkan gayab hai. Koi bhi gir sakta "
            "hai.",
            "{road} pe manhole ka cover toota hua hai {hi_duration}, raat ko bilkul dikhta nahi.",
        ],
        "te": [
            "{landmark} daggara manhole open ga undi, {te_duration} cover ledu. Evaraina padipotaru.",
            "{road} madhyalo manhole moota leka open ga undi, {te_duration} alage undi.",
        ],
    },
    "road_crack": {
        "en": [
            "Big cracks have developed on {road} near {landmark}; {hazard}.",
            "The road surface near {landmark} is badly damaged with deep cracks {duration}; {hazard}.",
            "Cracked and uneven road on {road} between {landmark} and the junction; {hazard}.",
            "Broken asphalt near {landmark} in {area} after the pipeline work {duration}; {hazard}.",
            "The newly laid road near {landmark} has already cracked and {hazard}.",
            "Road damage on {road} close to {landmark}: long cracks across the lane and {hazard}.",
        ],
        "hi": [
            "{landmark} ke paas road mein badi daraarein aa gayi hain {hi_duration}, road bilkul uneven ho "
            "gaya hai.",
            "{road} ka tar toot raha hai {hi_duration}, damaged road pe bike chalana mushkil hai.",
        ],
        "te": [
            "{landmark} daggara road cracks vachayi, {te_duration} road antha damage ayyindi.",
            "{road} lo road crack ayyi uneven ga undi, {te_duration} bikes jaaripotunnayi.",
        ],
    },
    "fallen_tree": {
        "en": [
            "A big tree has fallen across {road} near {landmark}; {hazard}.",
            "A huge branch broke off and is lying on {road} near {landmark} {duration}; {hazard}.",
            "An uprooted tree near {landmark} in {area} is blocking the road; {hazard}.",
            "The old tree near {landmark} came down in the storm and {hazard}.",
            "Fallen tree obstruction on {road} close to {landmark} {duration}; {hazard}.",
            "A tree has collapsed on the footpath next to {landmark}; {hazard}. Please send a team to "
            "clear it.",
        ],
        "hi": [
            "{landmark} ke paas bada ped gir gaya hai {hi_duration}, poora road block ho gaya hai.",
            "{road} pe ped ki daali tootkar giri hai {hi_duration}, gaadiyan nahi ja pa rahi.",
        ],
        "te": [
            "{landmark} daggara pedda chettu padindi, {te_duration} road block ayyindi.",
            "{road} lo chettu kommalu padipoyayi, {te_duration} evaru teeyaledu.",
        ],
    },
    "other": {
        "en": [
            "Stray dogs have become a big menace near {landmark} on {road}; {hazard}.",
            "Shopkeepers have encroached the entire footpath near {landmark}, so {hazard}.",
            "Stray cattle sit in the middle of {road} near {landmark} every evening and {hazard}.",
            "The bus shelter near {landmark} is damaged public property now - the roof sheets are hanging and "
            "{hazard}.",
            "Loudspeaker noise from a function hall near {landmark} till midnight every day; {hazard}.",
            "Illegal construction is encroaching the public road next to {landmark} in {area}; {hazard}.",
        ],
        "hi": [
            "{landmark} ke paas stray dogs ka bahut aatank hai {hi_duration}, bachche school jaane se darte "
            "hain.",
            "{road} pe footpath par encroachment ho gaya hai, {hi_duration} log road pe chal rahe hain.",
        ],
        "te": [
            "{landmark} daggara stray dogs ekkuva ayyayi, {te_duration} pillalu bhayapadutunnaru.",
            "{road} lo footpath antha encroachment, {te_duration} nadavataniki chotu ledu.",
        ],
    },
}

#: Routine requests without a hazard ("minor" tone, English). Slots as in COMPLAINT_TEMPLATES. They avoid the
#: words the NLP impact analysis treats as danger, traffic, health or disruption evidence, as a citizen reporting a
#: small problem would.
MINOR_TEMPLATES = {
    "pothole": [
        "Small pothole has formed on {road} near {landmark}. Please fill it during the next round of road "
        "maintenance.",
        "A shallow pothole has developed in the lane near {landmark} in {area}; kindly patch it before it grows.",
    ],
    "garbage": [
        "The garbage bin near {landmark} on {road} is full again. Kindly arrange an extra pickup this week.",
        "A few garbage bags have been left next to the bin near {landmark}. Please clear them on the next round.",
        "Dry leaves, litter and some garbage have piled up along {road} near {landmark}; the sweeping was missed for "
        "two days.",
        "Request a bigger dustbin near {landmark} in {area} - the present one fills up by evening.",
        "Garbage pickup in our lane near {landmark} was skipped yesterday. Please send the van.",
    ],
    "drainage": [
        "Silt has collected in the roadside drain on {road} near {landmark}. Please clean it before the next rain.",
        "The drain grating near {landmark} is choked with leaves, so rain water drains slowly.",
        "Kindly schedule desilting of the small drain in our lane near {landmark}; it was last cleaned before the "
        "summer.",
    ],
    "streetlight": [
        "One streetlight near {landmark} on {road} switches on late in the evening. Please check the timer.",
        "The streetlight outside {landmark} is flickering. Kindly replace the bulb.",
        "The street lamp near {landmark} in {area} stays on during the day. Please fix the timer.",
        "The streetlight near {landmark} is very dim compared to the others on {road}. Please replace the fixture.",
    ],
    "water_leak": [
        "Small leak from the water meter connection near {landmark} on {road}. It drips all day; please send a "
        "plumber.",
        "Minor leakage from the valve chamber near {landmark} in {area}. Not urgent, but please fix it when possible.",
        "The public tap near {landmark} does not close fully and keeps leaking. Please replace the tap.",
        "Slow seepage from a pipeline joint on {road} near {landmark}; a small wet patch has formed.",
    ],
    "open_manhole": [],
    "road_crack": [
        "Hairline cracks have appeared on {road} near {landmark}. Please seal them before the next rains.",
        "Minor cracks on the newly laid stretch near {landmark}; the surface is slightly uneven.",
        "A few small cracks have formed on {road} close to {landmark}. Kindly schedule crack sealing.",
        "The road edge near {landmark} in {area} is cracked and crumbling a little. Please patch it during routine "
        "maintenance.",
    ],
    "fallen_tree": [
        "A dry branch has broken off and is lying at the side of {road} near {landmark}. Please remove it.",
        "A small branch came down near {landmark} in last night's wind and is lying at the edge of the lane; kindly "
        "clear it.",
    ],
    "other": [
        "Posters and banners have been pasted everywhere near {landmark}; please remove them.",
        "An abandoned scooter has been parked near {landmark} on {road} for weeks. Please tow it away.",
        "A bench in the small park near {landmark} is broken and needs repair.",
        "Old hoardings near {landmark} in {area} are torn and flapping in the wind; please remove them.",
        "A few stray cattle rest near {landmark} in the afternoons. Please inform the cattle pound.",
    ],
}

#: Reports of a dangerous situation ("severe" tone, English): injuries, vulnerable people, urgency.
SEVERE_TEMPLATES = {
    "pothole": [
        "Deep pothole right at {landmark} on {road}; two bikers fell here this week and school children walk past "
        "it every morning. Please repair it urgently.",
        "A huge crater has opened on {road} in front of {landmark}. Vehicles swerve into oncoming traffic to avoid it "
        "and an auto overturned here last night. This is very dangerous.",
        "Massive potholes on {road} near {landmark} {duration}; an ambulance got stuck here yesterday and accidents "
        "happen every evening. Please fix it immediately.",
    ],
    "garbage": [
        "Huge garbage dump near {landmark} on {road} {duration}; it is rotting, mosquitoes are breeding and children "
        "in the colony have fever. Please clear it urgently.",
        "Garbage is being burnt every night near {landmark}; the smoke enters our houses and elderly people are "
        "having breathing problems.",
        "The garbage pile near {landmark} has spilled onto {road}; vehicles are skidding on the waste and stray dogs "
        "attack people walking by.",
    ],
    "drainage": [
        "Sewage is overflowing on {road} near {landmark} {duration}; dirty water is entering houses and children are "
        "falling sick with fever.",
        "Knee-deep sewage water near {landmark} on {road}; the drain has collapsed, mosquitoes are breeding and "
        "dengue cases are reported in our lane.",
        "The storm drain near {landmark} is completely blocked and {road} floods every evening; two-wheelers get "
        "stuck and water is entering shops.",
    ],
    "streetlight": [
        "All streetlights on {road} near {landmark} have been dead {duration}; the stretch is pitch dark and a live "
        "wire is hanging from the pole. Very dangerous for pedestrians.",
        "Electric wires are sparking from the streetlight pole near {landmark} on {road}; children play right next "
        "to it. Please disconnect it immediately.",
        "The streetlight pole near {landmark} is leaning dangerously over {road} after the rain and could fall on "
        "vehicles any moment.",
    ],
    "water_leak": [
        "Main pipeline burst on {road} near {landmark}; thousands of litres of drinking water are flowing on the "
        "road and the whole colony has no water supply.",
        "Contaminated water is coming from the leaking pipeline near {landmark} {duration}; several residents are "
        "sick with diarrhoea.",
        "A big water main has burst near {landmark} on {road}; the road is flooded and the surface is caving in.",
    ],
    "open_manhole": [
        "Open manhole without a cover in the middle of {road} near {landmark}; school children walk past it and a "
        "bike almost fell in last night. Please cover it immediately.",
        "Deep uncovered manhole near {landmark} on {road}; it is not visible at night and a woman fell in yesterday. "
        "Emergency - please barricade it now.",
        "The manhole cover near {landmark} is missing {duration}; sewage is overflowing and two-wheelers keep "
        "falling into it. Very dangerous.",
    ],
    "road_crack": [
        "Wide cracks have split {road} near {landmark}; the surface is collapsing and two bikes skidded here this "
        "week. Please repair it urgently.",
        "The road near {landmark} has caved in with deep cracks after the pipeline work; buses and ambulances "
        "struggle to pass.",
    ],
    "fallen_tree": [
        "A huge tree has fallen across {road} near {landmark} and is resting on the live electric wires; traffic is "
        "blocked and ambulances cannot pass.",
        "An uprooted tree crashed onto parked cars near {landmark} and is blocking {road}; please send a team "
        "immediately.",
        "A big tree near {landmark} is leaning dangerously over {road} after the storm and may fall on vehicles any "
        "moment.",
    ],
    "other": [
        "A pack of stray dogs near {landmark} has bitten two children this week; people are afraid to walk on "
        "{road}. Please act urgently.",
    ],
}

#: Citizen-written titles (most citizens leave the title blank and CivicAI generates one).
TITLE_TEMPLATES = {
    "pothole": ["Dangerous pothole near {landmark}", "Huge pothole on {road}", "Potholes on {road} - repair needed"],
    "garbage": ["Garbage not cleared near {landmark}", "Overflowing dustbin on {road}", "Garbage dump at {landmark}"],
    "drainage": ["Drain overflowing near {landmark}", "Waterlogging on {road}", "Blocked drain at {landmark}"],
    "streetlight": ["Streetlights not working on {road}", "Dark stretch near {landmark}",
                    "Streetlight off at {landmark}"],
    "water_leak": ["Pipeline leakage near {landmark}", "Drinking water wastage on {road}", "Water leak at {landmark}"],
    "open_manhole": ["Open manhole near {landmark} - urgent", "Manhole cover missing on {road}"],
    "road_crack": ["Badly damaged road near {landmark}", "Cracked road surface on {road}"],
    "fallen_tree": ["Tree fallen on {road}", "Fallen tree blocking road near {landmark}"],
    "other": ["Stray dog menace near {landmark}", "Footpath encroachment on {road}"],
}

#: Re-reports of the same issue by another citizen (paraphrases reusing the same place and hazard).
DUPLICATE_TEMPLATES = {
    "pothole": [
        "Reporting the pothole on {road} near {landmark} again - it is very deep and {hazard}.",
        "Same pothole near {landmark} on {road}: still not filled {duration}, {hazard}.",
        "Large pothole in front of {landmark} ({road}); {hazard}. Please fix it urgently.",
    ],
    "garbage": [
        "Garbage near {landmark} on {road} is still lying there {duration}; {hazard}.",
        "Please clear the garbage pile at {landmark}, {road} - {hazard}.",
        "Overflowing garbage at {landmark} on {road}; {hazard}.",
    ],
    "drainage": [
        "Drain overflowing on {road} near {landmark} {duration}; {hazard}.",
        "Blocked drain at {landmark} ({road}) - sewage on the road and {hazard}.",
        "Same drainage overflow near {landmark} on {road}; {hazard}.",
    ],
    "streetlight": [
        "Street lights near {landmark} on {road} are still off {duration}; {hazard}.",
        "No street light at {landmark}, {road} - {hazard}.",
        "Streetlight not working near {landmark} on {road}; {hazard}.",
    ],
    "water_leak": [
        "Water pipeline leak on {road} near {landmark} {duration}; {hazard}.",
        "Pipe leaking near {landmark} ({road}) - {hazard}.",
        "Same water leakage near {landmark} on {road}; {hazard}.",
    ],
    "open_manhole": [
        "Open manhole near {landmark} on {road} without a cover; {hazard}.",
        "Manhole at {landmark} ({road}) is still open {duration}; {hazard}.",
        "Uncovered manhole on {road} near {landmark} - {hazard}.",
    ],
    "road_crack": [
        "Cracked road near {landmark} on {road}; {hazard}.",
        "Road surface damaged at {landmark} ({road}) {duration}; {hazard}.",
    ],
    "fallen_tree": [
        "Fallen tree on {road} near {landmark}; {hazard}.",
        "Tree lying across the road at {landmark} ({road}) {duration}; {hazard}.",
    ],
    "other": [
        "Stray dog problem near {landmark} on {road}; {hazard}.",
        "Footpath near {landmark} ({road}) is encroached; {hazard}.",
    ],
}

# ---------------------------------------------------------------------------------------------------------------
# Officer / admin remarks
# ---------------------------------------------------------------------------------------------------------------
ACCEPT_REMARKS = [
    "Site inspection planned for today.",
    "Accepted. The field crew will visit the location shortly.",
    "Work order accepted; material requisition raised.",
    "Will inspect the spot this morning.",
    "Accepted - coordinating with the contractor.",
    "",
    "",
]

START_REMARKS = {
    "pothole": ["Patch-work crew on site with hot-mix asphalt.",
                "Area barricaded; cleaning the pothole edges before filling."],
    "garbage": ["Garbage lifting vehicle dispatched with four sanitation workers.",
                "Clearing started; a JCB is arranged for the bulk waste."],
    "drainage": ["Desilting team at the drain with a jetting machine.",
                 "Removing the blockage from the drain line."],
    "streetlight": ["Lineman checking the feeder and the fixture.",
                    "Replacing the faulty LED fixture and the timer."],
    "water_leak": ["Valve closed and digging started to reach the leaking joint.",
                   "Repair crew on site; the pipeline section is exposed."],
    "open_manhole": ["Spot barricaded with warning tape; a new cover is being fitted.",
                     "Temporary barricade placed; heavy-duty cover ordered."],
    "road_crack": ["Crack sealing in progress.", "Milling the damaged patch before relaying."],
    "fallen_tree": ["Tree cutting team with chainsaws on site.", "Clearing the branches from the carriageway."],
    "other": ["Field team inspecting the issue.", "Coordinating with the enforcement wing."],
}

RESOLVE_REMARKS = {
    "pothole": ["Pothole filled with hot-mix asphalt and compacted; surface levelled with the road.",
                "Pothole patched and rolled; barricades removed."],
    "garbage": ["Garbage cleared, the spot sanitised with bleaching powder and added to the daily pickup route.",
                "Bin point cleared and a new 1100-litre bin placed."],
    "drainage": ["Drain desilted and the blockage removed; water is flowing freely now.",
                 "Sewer line jetted and the overflowing chamber cleaned."],
    "streetlight": ["Faulty LED fixture replaced; all lights on the stretch are working.",
                    "Loose wire insulated and the streetlight restored."],
    "water_leak": ["Leaking joint replaced and the road restored; supply resumed.",
                   "Burst pipe section replaced and tested for pressure."],
    "open_manhole": ["New heavy-duty manhole cover installed and the frame fixed.",
                     "Manhole covered with a new lid and the area cleaned."],
    "road_crack": ["Cracks sealed and the damaged stretch relaid with bitumen.",
                   "Surface patched and levelled; the road is smooth now."],
    "fallen_tree": ["Fallen tree cut and removed; the road is clear for traffic.",
                    "Branches cleared and the remaining trunk removed from the footpath."],
    "other": ["Issue addressed by the enforcement team; the area is cleared.",
              "Necessary action taken and the spot inspected."],
}

REJECT_REMARKS = [
    "The spot is inside a private gated community maintained by the residents' association; the citizen has "
    "been informed.",
    "No such issue was found at the given location during inspection. Please share the exact spot if it "
    "persists.",
    "This stretch belongs to the National Highways Authority; the complaint has been forwarded to NHAI.",
    "The site is part of an ongoing Metro Rail work zone; the contractor is responsible for restoration.",
    "The location is outside the GHMC limits (gram panchayat area); the citizen has been advised accordingly.",
]

REOPEN_REASONS = {
    "pothole": ["The pothole has opened up again after yesterday's rain.",
                "Only a thin layer was laid; the pit is back within a week."],
    "garbage": ["Garbage is being dumped at the same spot again and nobody has cleared it.",
                "The bin is overflowing again; pickup is not happening daily."],
    "drainage": ["The drain is overflowing again since this morning.",
                 "Waterlogging is back after the first rain; the drain is still choked."],
    "streetlight": ["The light worked for two days and is off again.",
                    "The streetlight is flickering and goes off at night again."],
    "water_leak": ["Water is leaking again from the same joint.", "The leak has started again near the valve."],
    "open_manhole": ["The new cover is already broken and the manhole is open again."],
    "road_crack": ["The cracks have reappeared and are widening again."],
    "fallen_tree": ["Part of the trunk is still lying on the footpath."],
    "other": ["The problem has started again."],
}

#: Admin explanations for manual verification decisions.
MANUAL_VERIFIED_REMARKS = [
    "Ward engineer inspected the site: the repair is complete. The after photo was taken from a different angle, "
    "so the AI could not match the scene.",
    "Verified during the site visit; the work is done properly.",
    "Checked the photos and the site report - the remaining portion was completed the same day.",
]
SENT_BACK_REMARKS = [
    "The after photo shows the issue is still there; the work is incomplete. Please finish it and upload a new "
    "photo.",
    "Repair not visible in the after photo - please complete the work and resubmit.",
]
#: The same decisions for a resolution without an after photo (the real sample photos of a category may have no
#: repaired shot of the same spot): the administrator relies on a site visit instead of the AI comparison.
SITE_VISIT_VERIFIED_REMARKS = [
    "No after photo was uploaded, so the ward engineer inspected the site: the repair is complete.",
    "Verified during the site visit; the work is done properly.",
    "Site inspected with the officer - the repair is complete and the spot is safe again.",
]
SENT_BACK_SITE_REMARKS = [
    "Site inspection shows the issue is still there; the work is incomplete. Please finish it and upload an after "
    "photo.",
]
DUPLICATE_CONFIRMED_NOTES = [
    "Same issue reported again by another resident.",
    "Same spot and the same photo - merged into the original complaint.",
]
NOT_DUPLICATE_NOTES = [
    "Different spot further along the road; both need a separate repair.",
    "Separate issue in the next lane; keeping both complaints open.",
]
#: Review note when the original was already fixed before the re-report was reviewed (a recurrence, kept open).
RECURRENCE_NOTE = "The original complaint was already resolved; this report is handled as a new occurrence."
LEAVE_REASSIGN_NOTE = "Reassigned: the original officer is on leave."
WORKLOAD_REASSIGN_NOTE = "Reassigned to the zone engineer for workload balancing."

# ---------------------------------------------------------------------------------------------------------------
# Citizen feedback (sentiment is computed by the AI engine; the pools only steer the tone)
# ---------------------------------------------------------------------------------------------------------------
FEEDBACK_TEXTS = {
    "positive": [
        "The issue was resolved quickly, great work by the team. Thank you!",
        "Very happy with the quick response. Fixed within a day.",
        "Excellent work! The officer kept me updated and fixed it properly.",
        "Thank you GHMC, the problem is solved and the road looks good now.",
        "Bahut jaldi kaam ho gaya, thank you so much!",
        "Chala thanks, ippudu antha clean ga undi. Good work.",
        "Good job, resolved faster than I expected.",
        "Kaam bahut accha hua, officer ne khud aakar check kiya. Thank you.",
        "Problem fixed properly. Appreciate the quick action.",
        "Super fast service, the crew was polite and professional.",
    ],
    "neutral": [
        "The work is done but it took longer than expected.",
        "Issue is fixed for now, let us see if it lasts.",
        "Okay work, but the surface is still a bit uneven.",
        "Kaam ho gaya lekin thoda late hua.",
        "It was resolved, though nobody informed me before closing it.",
        "Average response. The repair is acceptable.",
        "Work completed after a few days. Will report again if the problem returns.",
        "The complaint was closed and the repair looks okay for now.",
    ],
    "negative": [
        "Still not fixed properly, just a temporary patch. Waste of time.",
        "Took more than a week and the problem is back already. Very disappointed.",
        "No action for many days, I had to follow up again and again.",
        "Kuch kaam nahi hua, bas photo lekar chale gaye. Very bad.",
        "Very poor quality work, the problem has come back again.",
        "Resolved only on paper. The issue is still there. Worst experience.",
    ],
}


def fill(template, slots):
    """``template.format(**slots)`` where ``{hazard_sentence}`` is the hazard as a capitalised sentence."""
    hazard = slots.get("hazard", "")
    values = dict(slots, hazard_sentence=(hazard[:1].upper() + hazard[1:] + ".") if hazard else "")
    return " ".join(template.format(**values).split())
